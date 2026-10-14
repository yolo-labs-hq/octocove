import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
export function send({ url, method = 'POST', headers = {}, body, tls, ca, localAddress }) {
    return new Promise(resolve => {
        const target = new URL(url), secure = target.protocol === 'https:';
        const req = (secure ? httpsRequest : httpRequest)(target, { method, headers: { ...headers, 'content-length': body ? body.length : 0 },
            ...(secure ? { ca, ...(tls ? { key: tls.key, cert: tls.cert } : {}), servername: 'localhost', agent: false } : {}), localAddress }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('latin1') }));
        });
        req.on('error', error => resolve({ status: 0, text: error.code ?? 'error' }));
        req.end(body);
    });
}
