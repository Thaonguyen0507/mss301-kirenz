import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

messages = []


class Mailbox(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, code, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        recipient = query.get('to', [''])[0]
        found = [m for m in messages if not recipient or any(t.get('email') == recipient for t in m.get('to', []))]
        self.respond(200, {'messages': found})

    def do_POST(self):
        if 'chunked' in self.headers.get('Transfer-Encoding', '').lower():
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b';', 1)[0].strip(), 16)
                if not size:
                    while self.rfile.readline().strip():
                        pass
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            payload = b''.join(chunks)
        else:
            length = int(self.headers.get('Content-Length', '0'))
            payload = self.rfile.read(length)
        messages.append(json.loads(payload or b'{}'))
        self.respond(201, {'messageId': f'local-test-{len(messages)}'})


HTTPServer(('0.0.0.0', 1080), Mailbox).serve_forever()
