import type { HttpMethod } from '../data/mock';

export function MethodTag({ method }: { method: HttpMethod }) {
  return <span className={`method-tag method-${method.toLowerCase()}`}>{method}</span>;
}
