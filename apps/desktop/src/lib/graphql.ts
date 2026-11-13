import type { NetworkMode } from '../data/types';
import { sendHttpRequest, type HeaderPair } from './api';
import { backendNetworkOptions } from './network';

const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    types {
      kind
      name
      description
      fields {
        name
        description
        args { name type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } }
      enumValues { name description }
    }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
}`;

export interface GraphqlTypeRef {
  kind: string;
  name?: string | null;
  ofType?: GraphqlTypeRef | null;
}

export interface GraphqlField {
  name: string;
  description?: string | null;
  args?: { name: string; type: GraphqlTypeRef }[];
  type: GraphqlTypeRef;
}

export interface GraphqlEnumValue {
  name: string;
  description?: string | null;
}

export interface GraphqlType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: GraphqlField[] | null;
  inputFields?: GraphqlField[] | null;
  enumValues?: GraphqlEnumValue[] | null;
}

interface IntrospectionResult {
  data?: { __schema?: { types?: GraphqlType[] } };
  errors?: { message?: string }[];
}

export function formatTypeRef(type: GraphqlTypeRef | null | undefined): string {
  if (!type) return 'Unknown';
  if (type.kind === 'NON_NULL') return `${formatTypeRef(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${formatTypeRef(type.ofType)}]`;
  return type.name ?? type.kind;
}

export async function fetchGraphqlSchema(
  url: string,
  headers: HeaderPair[],
  networkMode: NetworkMode,
): Promise<GraphqlType[]> {
  const normalized = headers.filter(
    (header) => header.name.trim() && header.name.toLowerCase() !== 'content-type',
  );

  const response = await sendHttpRequest({
    method: 'POST',
    url,
    headers: [
      ...normalized,
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'application/json' },
    ],
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    timeoutMs: 30_000,
    network: backendNetworkOptions(networkMode),
  });

  if (response.status >= 400) {
    throw new Error(`获取 Schema 失败：${response.status} ${response.statusText}`);
  }

  let parsed: IntrospectionResult;
  try {
    parsed = JSON.parse(response.body) as IntrospectionResult;
  } catch {
    throw new Error('获取 Schema 失败：响应不是合法 JSON');
  }

  if (parsed.errors?.length) {
    throw new Error(`获取 Schema 失败：${parsed.errors[0].message ?? '未知错误'}`);
  }

  const types = parsed.data?.__schema?.types;
  if (!Array.isArray(types)) {
    throw new Error('响应中没有 __schema.types，请确认该地址支持 introspection');
  }

  return types
    .filter((type) => type.name && !type.name.startsWith('__'))
    .sort((left, right) => left.name.localeCompare(right.name));
}
