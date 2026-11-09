import type { HttpMethod } from '../data/types';

export function MethodTag({ method }: { method: HttpMethod }) {
  return <span className={`method-tag method-${method.toLowerCase()}`}>{method}</span>;
}
