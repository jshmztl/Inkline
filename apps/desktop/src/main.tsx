import React from 'react';
import ReactDOM from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import 'antd/dist/reset.css';
import './styles.css';
import { getCssVars, type ThemeMode } from '@inkline/ui';
import { App } from './App';
import { initKv, kvGet } from './lib/kv';
import { migratePlaintextSecrets } from './lib/secretMigration';
import { hydrateSecretStore } from './lib/secretStore';
import { hydrateTeamSecrets } from './lib/teamSecrets';

async function bootstrap() {
  await initKv();
  await hydrateSecretStore();
  await migratePlaintextSecrets();
  await hydrateTeamSecrets();

  const mode: ThemeMode = kvGet('aw-theme') === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;

  for (const [name, value] of Object.entries(getCssVars(mode))) {
    root.style.setProperty(name, value);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
