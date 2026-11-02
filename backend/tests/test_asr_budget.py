"""Offline Qwen-ASR duration accounting against the shared text-model budget."""
import copy
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from backend.billing import BillingError, Ledger, SHARED_ACCOUNT, cost
from backend.cloud_service import CloudService, Connections


PRICE = json.loads((Path(__file__).parents[1] / 'platform-price.json').read_text('utf-8'))
ASR_PRICE = PRICE['asr']
RATE = 220000


class AsrSharedBudget(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / 'shared.sqlite3'
        self.price = copy.deepcopy(PRICE)
        # Test fixed tariffs without depending on the real Beijing wall clock.
        self.price.pop('off_peak', None)
        self.ledger = Ledger(self.database, 10_000_000_000, price=self.price)
        self.runtime = SimpleNamespace(snapshot=lambda: ('offline-test-platform-key', True, True))
        self.audio = self.root / 'audio.mp3'
        self.audio.write_bytes(b'offline-fixture-never-uploaded')

    def tearDown(self):
        self.temporary.cleanup()

    def service(self, visitor='visitor-a', ledger=None):
        return CloudService(visitor, ledger or self.ledger, Connections(), platform_runtime=self.runtime)

    def body(self, key):
        return {'tool': 'ynote', 'billing_mode': 'platform', 'idempotency_key': key}

    def probe(self, duration='5.250001'):
        return subprocess.CompletedProcess([], 0, stdout=json.dumps({
            'format': {'duration': duration, 'format_name': 'mp3'},
            'streams': [{'codec_type': 'audio'}],
        }).encode())

    def test_duration_cost_uses_integer_microseconds_and_ceil_nano_cny(self):
        self.assertEqual(ASR_PRICE['model'], 'Qwen/Qwen3-ASR-1.7B')
        self.assertEqual(ASR_PRICE['audio_nano_cny_per_second'], RATE)
        for microseconds, expected in [
            (1, 1), (4, 1), (5, 2), (1000000, 220000),
            (5250001, 1155001), (432480000, 95145600),
            (3600000000, 792000000),
        ]:
            with self.subTest(microseconds=microseconds):
                self.assertEqual(cost({'audio_duration_us': microseconds}, ASR_PRICE), expected)
        for invalid in [None, 0, -1, True, 1.5, '1000000']:
            with self.subTest(invalid=invalid):
                with self.assertRaises(BillingError):
                    cost({'audio_duration_us': invalid}, ASR_PRICE)
        with self.assertRaises(BillingError):
            cost({}, ASR_PRICE)
        with self.assertRaises(BillingError):
            cost({'audio_duration_us': 10**30}, ASR_PRICE)

    def test_asr_and_text_from_different_visitors_share_one_account(self):
        asr = self.service('asr-visitor')
        text = self.service('text-visitor')
        response = httpx.Response(200, json={'text': '离线转写结果'})
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream', return_value=response) as provider:
            asr.transcribe(self.audio, self.body('speech'))
            self.assertEqual(provider.call_count, 1)
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT)['used_nano_cny'], '1155001')
        usage = {'prompt_tokens': 1000, 'completion_tokens': 500,
                 'prompt_tokens_details': {'cached_tokens': 200}}
        text_response = httpx.Response(200, json={
            'choices': [{'message': {'content': '离线文本结果'}, 'finish_reason': 'stop'}],
            'usage': usage,
        })
        with patch('backend.cloud_service.upstream', return_value=text_response):
            text.text('用于离线验证的资料。', self.body('note'))
        expected = 1155001 + cost(usage, self.price)
        quota = self.ledger.quota(SHARED_ACCOUNT)
        self.assertEqual(quota['used_nano_cny'], str(expected))
        self.assertEqual(quota['reserved_nano_cny'], '0')
        self.assertEqual(quota['remaining_nano_cny'], str(10_000_000_000 - expected))
        with self.ledger.tx() as database:
            users = database.execute('SELECT DISTINCT user FROM yn_calls').fetchall()
        self.assertEqual(users, [(SHARED_ACCOUNT,)])

    def test_text_spending_reduces_asr_budget_and_blocks_before_provider(self):
        ledger = Ledger(self.database, 10_000_000, price=self.price)  # CNY 0.01
        ledger.reserve(SHARED_ACCOUNT, 'text-spend', {'kind': 'text'}, 9_000_000)
        ledger.finish(SHARED_ACCOUNT, 'text-spend',
                      {'prompt_tokens': 4500, 'completion_tokens': 0}, 'done')
        self.assertEqual(ledger.quota(SHARED_ACCOUNT)['remaining_nano_cny'], '1000000')
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError) as blocked:
                self.service(ledger=ledger).transcribe(self.audio, self.body('insufficient'))
            self.assertEqual(blocked.exception.error['code'], 'QUOTA_EXCEEDED')
            provider.assert_not_called()
        self.assertEqual(ledger.quota(SHARED_ACCOUNT)['reserved_nano_cny'], '0')

    def test_asr_replay_survives_restart_without_provider_or_double_charge(self):
        response = httpx.Response(200, json={'text': '可重放的离线结果'})
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream', return_value=response) as provider:
            original = self.service().transcribe(self.audio, self.body('durable'))
            before = self.ledger.quota(SHARED_ACCOUNT)
            restarted = Ledger(self.database, 10_000_000_000, price=self.price)
            replay = self.service(ledger=restarted).transcribe(self.audio, self.body('durable'))
            self.assertEqual(replay, original)
            self.assertEqual(provider.call_count, 1)
            self.assertEqual(restarted.quota(SHARED_ACCOUNT), before)
            self.audio.write_bytes(b'different-source')
            with self.assertRaises(BillingError) as conflict:
                self.service(ledger=restarted).transcribe(self.audio, self.body('durable'))
            self.assertEqual(conflict.exception.error['code'], 'IDEMPOTENCY_CONFLICT')
            self.assertEqual(provider.call_count, 1)

    def test_zero_budget_blocks_asr_without_provider(self):
        ledger = Ledger(self.database, 0, price=self.price)
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError) as blocked:
                self.service(ledger=ledger).transcribe(self.audio, self.body('paused'))
            self.assertEqual(blocked.exception.error['code'], 'PLATFORM_BUDGET_PAUSED')
            provider.assert_not_called()
        self.assertEqual(ledger.quota(SHARED_ACCOUNT)['budget_state'], 'paused')

    def test_uncertain_asr_retains_bound_and_will_not_resend_after_restart(self):
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream', side_effect=httpx.ReadTimeout('offline-timeout')) as provider:
            with self.assertRaises(BillingError) as uncertain:
                self.service().transcribe(self.audio, self.body('uncertain'))
            self.assertEqual(uncertain.exception.error['code'], 'ACCOUNTING_REVIEW')
            restarted = Ledger(self.database, 10_000_000_000, price=self.price)
            with self.assertRaises(BillingError):
                self.service(ledger=restarted).transcribe(self.audio, self.body('uncertain'))
            self.assertEqual(provider.call_count, 1)
        quota = restarted.quota(SHARED_ACCOUNT)
        self.assertEqual(quota['used_nano_cny'], '0')
        self.assertEqual(quota['reserved_nano_cny'], str(6 * RATE))
        with restarted.tx() as database:
            self.assertEqual(database.execute('SELECT state FROM yn_calls').fetchone()[0], 'review')

    def test_cross_midnight_settlement_stays_on_reserved_day(self):
        before = datetime(2026, 10, 27, 15, 59, 59, tzinfo=timezone.utc)
        after = datetime(2026, 10, 27, 16, 0, 1, tzinfo=timezone.utc)
        payload = {'kind': 'asr', 'source': 'offline-midnight'}
        self.ledger.reserve(SHARED_ACCOUNT, 'midnight-asr', payload, 6 * RATE,
                            at=before, price_snapshot=ASR_PRICE)
        restarted = Ledger(self.database, 10_000_000_000, price=self.price)
        restarted.finish(SHARED_ACCOUNT, 'midnight-asr', {'audio_duration_us': 5250001}, {'text': 'done'})
        self.assertEqual(restarted.quota(SHARED_ACCOUNT, at=before)['used_nano_cny'], '1155001')
        next_day = restarted.quota(SHARED_ACCOUNT, at=after)
        self.assertEqual((next_day['used_nano_cny'], next_day['reserved_nano_cny']), ('0', '0'))
        self.assertEqual(restarted.reserve(SHARED_ACCOUNT, 'midnight-asr', payload, 6 * RATE,
                                          at=after, price_snapshot=ASR_PRICE), {'text': 'done'})
        self.assertEqual(restarted.quota(SHARED_ACCOUNT, at=after), next_day)

    def test_quick_precise_and_text_route_into_one_shared_budget(self):
        calls = []
        usage = {'prompt_tokens': 1000, 'completion_tokens': 500}

        def respond(method, base, endpoint, key, **kwargs):
            if endpoint == '/audio/transcriptions':
                model = kwargs['data']['model']
                calls.append(model)
                return httpx.Response(200, json={'text': '离线转写：' + model})
            self.assertEqual(endpoint, '/chat/completions')
            calls.append(kwargs['json']['model'])
            return httpx.Response(200, json={
                'choices': [{'message': {'content': '离线笔记'}, 'finish_reason': 'stop'}],
                'usage': usage,
            })

        quick = {**self.body('quick-route'), 'extraction_mode': 'quick', 'model': 'untrusted-override'}
        precise = {**self.body('precise-route'), 'extraction_mode': 'precise'}
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream', side_effect=respond):
            self.service('quick-visitor').transcribe(self.audio, quick)
            after_quick = self.ledger.quota(SHARED_ACCOUNT)
            self.assertEqual((after_quick['used_nano_cny'], after_quick['reserved_nano_cny']), ('0', '0'))
            self.service('precise-visitor').transcribe(self.audio, precise)
            self.assertEqual(self.ledger.quota(SHARED_ACCOUNT)['used_nano_cny'], '1155001')
            self.service('text-visitor').text('两种提取都使用同一文本服务。', self.body('shared-note'))
        self.assertEqual(calls, [
            'FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen3-ASR-1.7B', self.price['model'],
        ])
        expected = 1155001 + cost(usage, self.price)
        quota = self.ledger.quota(SHARED_ACCOUNT)
        self.assertEqual(quota['used_nano_cny'], str(expected))
        self.assertEqual(quota['remaining_nano_cny'], str(10_000_000_000 - expected))
        with self.ledger.tx() as database:
            rows = database.execute('SELECT user,cost,price FROM yn_calls').fetchall()
        self.assertTrue(all(row[0] == SHARED_ACCOUNT for row in rows))
        quick_rows = [row for row in rows if json.loads(row[2]).get('model') == 'FunAudioLLM/SenseVoiceSmall']
        self.assertEqual(len(quick_rows), 1)
        self.assertEqual(quick_rows[0][1], 0)

    def test_same_idempotency_key_cannot_change_extraction_mode_either_direction(self):
        for first, second in [('quick', 'precise'), ('precise', 'quick')]:
            with self.subTest(first=first, second=second), \
                 patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
                 patch('backend.cloud_service.upstream', return_value=httpx.Response(200, json={'text': '离线结果'})) as provider:
                key = 'fixed-mode-' + first
                service = self.service()
                service.transcribe(self.audio, {**self.body(key), 'extraction_mode': first})
                before = self.ledger.quota(SHARED_ACCOUNT)
                with self.assertRaises(BillingError) as conflict:
                    service.transcribe(self.audio, {**self.body(key), 'extraction_mode': second})
                self.assertEqual(conflict.exception.error['code'], 'IDEMPOTENCY_CONFLICT')
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(self.ledger.quota(SHARED_ACCOUNT), before)

    def test_free_quick_still_obeys_zero_budget_and_exhausted_shared_budget(self):
        for state in ['paused', 'spent', 'reserved']:
            with self.subTest(state=state):
                ledger = Ledger(self.root / (state + '.sqlite3'),
                                0 if state == 'paused' else 10_000_000, price=self.price)
                if state != 'paused':
                    ledger.reserve(SHARED_ACCOUNT, 'all-budget', {'kind': 'text'}, 10_000_000)
                    if state == 'spent':
                        ledger.finish(SHARED_ACCOUNT, 'all-budget',
                                      {'prompt_tokens': 5000, 'completion_tokens': 0}, 'done')
                before = ledger.quota(SHARED_ACCOUNT)
                with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
                     patch('backend.cloud_service.upstream') as provider:
                    with self.assertRaises(BillingError) as blocked:
                        self.service(ledger=ledger).transcribe(
                            self.audio, {**self.body('free-quick'), 'extraction_mode': 'quick'})
                    self.assertEqual(blocked.exception.error['code'],
                                     'PLATFORM_BUDGET_PAUSED' if state == 'paused' else 'QUOTA_EXCEEDED')
                    provider.assert_not_called()
                self.assertEqual(ledger.quota(SHARED_ACCOUNT), before)

    def test_quick_replay_is_persistent_and_invalid_mode_never_calls_provider(self):
        with patch('backend.cloud_service.subprocess.run', return_value=self.probe()), \
             patch('backend.cloud_service.upstream', return_value=httpx.Response(200, json={'text': '快速结果'})) as provider:
            body = {**self.body('quick-persistent'), 'extraction_mode': 'quick'}
            result = self.service().transcribe(self.audio, body)
            restarted = Ledger(self.database, 10_000_000_000, price=self.price)
            self.assertEqual(self.service(ledger=restarted).transcribe(self.audio, body), result)
            self.assertEqual(provider.call_count, 1)
            self.assertEqual(restarted.quota(SHARED_ACCOUNT)['used_nano_cny'], '0')
            with self.assertRaises(BillingError) as invalid:
                self.service().transcribe(self.audio, {**self.body('invalid-mode'), 'extraction_mode': 'unknown'})
            self.assertEqual(invalid.exception.error['code'], 'INVALID_INPUT')
            self.assertEqual(provider.call_count, 1)


if __name__ == '__main__':
    unittest.main()
