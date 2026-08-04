import http from 'k6/http';
import { check, sleep } from 'k6';

const base = __ENV.BASE_URL || 'http://192.168.0.112:23191';
export const options = { vus: Number(__ENV.VUS || 1), iterations: Number(__ENV.ITERATIONS || 10), thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<5000'] } };

export default function () {
  const res = http.get(`${base}/`);
  check(res, { 'HTTP 200': r => r.status === 200, 'not paused': r => !r.body.includes('This deployment is temporarily paused'), 'not 5xx': r => r.status < 500 });
  sleep(Number(__ENV.INTERVAL_SECONDS || 60));
}
