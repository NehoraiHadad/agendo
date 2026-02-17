import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TerminalTokenPayload {
  sessionName: string;
  userId: string;
  exp: number;
}

export function createTerminalToken(
  payload: Omit<TerminalTokenPayload, 'exp'>,
  secret: string,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + 300;
  const body = base64url(JSON.stringify({ ...payload, exp }));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

export function verifyTerminalToken(token: string, secret: string): TerminalTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  const [header, body, sig] = parts;
  const expectedSig = sign(`${header}.${body}`, secret);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature');
  }
  const payload = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf-8'),
  ) as TerminalTokenPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}
