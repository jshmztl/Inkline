import {
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { ConfigProvider } from 'antd';
import { XProvider } from '@ant-design/x';
import {
  getCssVars,
  getThemeConfig,
  type Density,
  type ThemeMode,
} from './theme';

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface AntProviderProps {
  mode?: ThemeMode;
  density?: Density;
  /** 是否为自定义组件注入 --aw-* CSS 变量 */
  injectCssVars?: boolean;
  children: ReactNode;
}

/**
 * Ant Design + Ant Design X 的统一入口。
 * Ant 组件消费 ThemeConfig，自定义组件消费 --aw-* CSS 变量。
 */
export function AntProvider({
  mode = 'light',
  density = 'default',
  injectCssVars = true,
  children,
}: AntProviderProps) {
  const themeConfig = useMemo(
    () => getThemeConfig(mode, density),
    [mode, density],
  );

  useIsomorphicLayoutEffect(() => {
    if (!injectCssVars || typeof document === 'undefined') return;

    const root = document.documentElement;
    root.dataset.theme = mode;
    root.style.colorScheme = mode;

    const vars = getCssVars(mode, density);
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }
  }, [mode, density, injectCssVars]);

  return (
    <ConfigProvider theme={themeConfig}>
      <XProvider>{children}</XProvider>
    </ConfigProvider>
  );
}
