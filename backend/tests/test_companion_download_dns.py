"""Offline checks for the downloader's approved-CDN/proxy DNS boundary."""
import os
import socket
import unittest
from unittest.mock import patch
from companion.network_guard import install_network


def row(address,port=443):return [(socket.AF_INET,socket.SOCK_STREAM,6,'',(address,int(port)))]


class CompanionDownloadDNS(unittest.TestCase):
    def test_proxy_addresses_require_public_verification_and_no_private_admission(self):
        def original(host,port,*args,**kwargs):
            if host=='www.bilibili.com':return row('198.18.0.123',port)
            return row(host,port)
        with patch.dict(os.environ,{'YNOTE_PROXY_DNS_VERIFY':'1'}),patch('socket.getaddrinfo',side_effect=original),patch('socket.socket.connect'),patch('socket.socket.connect_ex',return_value=0),patch('companion.network_guard.public_source_addresses',return_value=['103.151.151.134']) as verify:
            install_network()
            result=socket.getaddrinfo('www.bilibili.com',443)
            self.assertEqual(result[0][4][0],'103.151.151.134')
            self.assertEqual(verify.call_args.kwargs['doh_endpoint'],'https://8.8.8.8/resolve')
            with self.assertRaises(OSError):socket.getaddrinfo('evil.example',443)
            with self.assertRaises(OSError):socket.getaddrinfo('www.bilibili.com',8080)
            with self.assertRaises(OSError):socket.socket().connect(('127.0.0.1',443))

    def test_unverified_fake_ip_is_blocked(self):
        with patch('socket.getaddrinfo',return_value=row('198.18.0.123')),patch('socket.socket.connect'),patch('socket.socket.connect_ex',return_value=0),patch('companion.network_guard.public_source_addresses',return_value=[]):
            install_network()
            with self.assertRaises(OSError):socket.getaddrinfo('www.bilibili.com',443)

    def test_direct_public_cdn_needs_no_dns_service(self):
        with patch('socket.getaddrinfo',return_value=row('103.151.151.134')),patch('socket.socket.connect'),patch('socket.socket.connect_ex',return_value=0),patch('companion.network_guard.public_source_addresses') as verify:
            install_network()
            self.assertEqual(socket.getaddrinfo('www.bilibili.com',443)[0][4][0],'103.151.151.134')
            verify.assert_not_called()
