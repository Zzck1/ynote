"""Validate proxy Fake-IP answers against a public HTTPS DNS resolver."""
import ipaddress
import json
import os
import socket
from urllib.parse import urlencode
from urllib.request import Request, urlopen

FAKE_IP = ipaddress.ip_network('198.18.0.0/15')


def routable(address):
    return address.is_global and not address.is_multicast and not address.is_reserved and not address.is_unspecified


def public_source_addresses(host, port=443, resolver=None, doh_endpoint='https://dns.google/resolve'):
    # Call only after the caller has checked its supported-platform allowlist.
    if doh_endpoint not in ('https://dns.google/resolve','https://8.8.8.8/resolve'):return []
    addresses = [ipaddress.ip_address(row[4][0]) for row in (resolver or socket.getaddrinfo)(host, port)]
    if not addresses:
        return []
    if all(routable(address) for address in addresses):
        return [str(address) for address in addresses]
    if os.environ.get('YNOTE_PROXY_DNS_VERIFY') != '1':
        return []
    if any(not routable(address) and address not in FAKE_IP for address in addresses):
        return []
    request = Request(doh_endpoint+'?' + urlencode({'name': host, 'type': 'A'}),
                      headers={'Accept': 'application/dns-json'})
    try:
        with urlopen(request, timeout=10) as response:
            if response.geturl().split('?')[0] != doh_endpoint:
                return []
            data = json.loads(response.read(65537))
        if data.get('Status') != 0:
            return []
        public = [ipaddress.ip_address(answer['data']) for answer in data.get('Answer', [])
                  if answer.get('type') in (1, 28)]
        return [str(address) for address in public] if public and all(routable(address) for address in public) else []
    except (OSError, ValueError, KeyError, TypeError):
        return []


def public_source_host(host, port=443):
    return bool(public_source_addresses(host, port))
