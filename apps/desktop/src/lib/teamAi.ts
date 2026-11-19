import type { AiGatewayConfig, AiProvider } from './aiGateway';
import { readTeamConnection, teamRequest, type TeamConnection } from './teamClient';

export interface TeamAiConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  updatedAt?: string | null;
}

let cached: { teamId: string; config: TeamAiConfig } | null = null;

export async function loadTeamAiConfig(
  connection: TeamConnection,
  teamId: string,
): Promise<TeamAiConfig | null> {
  const data = (await teamRequest(
    connection,
    `/v1/teams/${teamId}/ai-config`,
  )) as { config?: TeamAiConfig | null } | null;
  cached = data?.config ? { teamId, config: data.config } : null;
  return data?.config ?? null;
}

export function clearTeamAiConfig() {
  cached = null;
}

export function hasTeamGatewayConfig(): boolean {
  const config = cached?.config;
  return Boolean(config?.enabled && config.baseUrl.trim() && config.model.trim());
}

export function getTeamGatewayConfig(): AiGatewayConfig | null {
  if (!cached || !hasTeamGatewayConfig()) return null;
  const connection = readTeamConnection();
  if (!connection) return null;
  return {
    provider: cached.config.provider as AiProvider,
    baseUrl: `${connection.serverUrl}/v1/teams/${cached.teamId}/ai`,
    model: cached.config.model,
    apiKey: connection.accessToken,
    source: 'team',
  };
}

export async function refreshTeamGatewayToken(): Promise<boolean> {
  const connection = readTeamConnection();
  if (!connection) return false;
  try {
    await teamRequest(connection, '/v1/me');
    return true;
  } catch {
    return false;
  }
}
