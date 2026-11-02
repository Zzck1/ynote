import io
import json
import os
import unittest
from unittest.mock import patch
from backend.network_dns import public_source_host
from backend.app import safe_source_url, Problem


class ProxyDNSTests(unittest.TestCase):
    def check(self, addresses, answers, enabled='1'):
        response = io.BytesIO(json.dumps(answers).encode())
        response.geturl = lambda: 'https://dns.google/resolve?name=www.bilibili.com&type=A'
        with patch.dict(os.environ, {'YNOTE_PROXY_DNS_VERIFY': enabled}), \
             patch('backend.network_dns.socket.getaddrinfo', return_value=[(2, 1, 6, '', (ip, 443)) for ip in addresses]), \
             patch('backend.network_dns.urlopen', return_value=response) as resolver:
            result = public_source_host('www.bilibili.com')
            return result, resolver.call_count

    def test_public_dns_needs_no_fallback(self):
        self.assertEqual(self.check(['8.8.8.8'], {}), (True, 0))

    def test_fake_ip_requires_explicit_configuration(self):
        self.assertEqual(self.check(['198.18.0.145'], {}, '0'), (False, 0))

    def test_fake_ip_with_public_verification(self):
        self.assertEqual(self.check(['198.18.0.145'], {'Status': 0, 'Answer': [{'type': 1, 'data': '103.151.151.134'}]}), (True, 1))

    def test_private_and_loopback_remain_blocked(self):
        for ip in ['127.0.0.1', '10.0.0.1', '192.168.1.2', '169.254.169.254', '::1', '224.0.0.1', 'ff02::1']:
            with self.subTest(ip=ip):
                self.assertEqual(self.check([ip], {}), (False, 0))

    def test_invalid_or_private_public_answers_fail_closed(self):
        for data in [{'Status': 2}, {'Status': 0, 'Answer': []}, {'Status': 0, 'Answer': [{'type': 1, 'data': '127.0.0.1'}]}, {'Status': 0, 'Answer': [{'type': 1, 'data': 'invalid'}]}]:
            self.assertFalse(self.check(['198.18.0.145'], data)[0])

    def test_unknown_hosts_and_credentials_are_rejected_before_dns(self):
        with patch('backend.network_dns.public_source_host') as resolver:
            for url in ['https://evil.example/a', 'https://127.0.0.1/a', 'https://user:pass@bilibili.com/a']:
                with self.assertRaises(Problem):
                    safe_source_url(url)
            resolver.assert_not_called()
