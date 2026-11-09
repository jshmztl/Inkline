import React from 'react';
import ReactDOM from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import 'antd/dist/reset.css';
import './styles.css';
import { getCssVars, type ThemeMode } from '@api-workbench/ui';
import { App } from './App';

const mode: ThemeMode = localStorage.getItem('aw-theme') === 'dark' ? 'dark' : 'light';
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
