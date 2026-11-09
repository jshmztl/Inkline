import { theme as antdTheme, type ThemeConfig } from 'antd';

export type ThemeMode = 'light' | 'dark';
export type Density = 'compact' | 'default' | 'comfortable';
export type ClassificationLevel = 'l0' | 'l1' | 'l2' | 'l3';

export const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export const fontFamilyCode =
  'ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace';

/** 8px 网格；4 只用于行内元素与图标对齐。 */
export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
} as const;

export const typeScale = {
  caption: 12,
  body: 14,
  subtitle: 16,
  title4: 20,
  title3: 24,
  title2: 30,
  title1: 38,
} as const;

export const motion = {
  fast: '120ms',
  base: '200ms',
  slow: '240ms',
} as const;

export const densityControlHeight: Record<Density, number> = {
  compact: 28,
  default: 32,
  comfortable: 36,
};

const lightColors = {
  primary: '#4F46E5',
  primaryHover: '#6366F1',
  primaryActive: '#4338CA',
  primaryBg: '#EEF0FF',
  primaryBorder: '#C7C9FC',

  accent2: '#8B5CF6',
  accent2Bg: '#F4EEFF',
  accent2Border: '#DDCCFF',

  success: '#0E9F6E',
  successBg: '#E8FAF3',
  successBorder: '#A8E6CF',

  warning: '#C2740B',
  warningBg: '#FFF6E5',
  warningBorder: '#FAD9A0',

  error: '#DC2A3E',
  errorBg: '#FFEEF0',
  errorBorder: '#F9C2C8',

  info: '#0891B2',
  infoBg: '#E6F8FB',
  infoBorder: '#A5E3EE',

  purple: '#7C3AED',
  purpleBg: '#F3EEFF',
  purpleBorder: '#DCCBFF',

  bg: '#F3F5FA',
  surface: '#FFFFFF',
  surface2: '#F5F7FC',
  surface3: '#E9EDF6',

  ink: '#131722',
  ink2: '#333A4A',
  muted: '#5A6377',
  faint: '#8A93A6',
  line: '#E3E8F2',
  lineStrong: '#CFD6E4',

  codeBg: '#F7F9FE',
  codeInk: '#262E3F',

  shadow1:
    '0 1px 2px -2px rgba(23,29,48,.10), 0 3px 6px 0 rgba(23,29,48,.08), 0 5px 12px 4px rgba(23,29,48,.05)',
  shadow2:
    '0 3px 6px -4px rgba(23,29,48,.10), 0 6px 16px 0 rgba(23,29,48,.07), 0 9px 28px 8px rgba(23,29,48,.05)',
  shadow3:
    '0 6px 16px -8px rgba(23,29,48,.08), 0 9px 28px 0 rgba(23,29,48,.05), 0 12px 48px 16px rgba(23,29,48,.04)',
} as const;

const darkColors: Record<keyof typeof lightColors, string> = {
  primary: '#818CF8',
  primaryHover: '#A5B4FC',
  primaryActive: '#6366F1',
  primaryBg: '#232452',
  primaryBorder: '#4F46E5',

  accent2: '#A78BFA',
  accent2Bg: '#2A2048',
  accent2Border: '#6D4FD0',

  success: '#34D399',
  successBg: '#10291F',
  successBorder: '#1D6B4F',

  warning: '#F4B740',
  warningBg: '#2B2111',
  warningBorder: '#7C5914',

  error: '#F87171',
  errorBg: '#2C1418',
  errorBorder: '#7F2027',

  info: '#22D3EE',
  infoBg: '#0D2429',
  infoBorder: '#155E6B',

  purple: '#C4B5FD',
  purpleBg: '#221A3C',
  purpleBorder: '#4C3A85',

  bg: '#0A0D14',
  surface: '#121826',
  surface2: '#1A2233',
  surface3: '#232D40',

  ink: '#E8EDF7',
  ink2: '#C4CDDF',
  muted: '#9AA6BD',
  faint: '#7C889E',
  line: '#233049',
  lineStrong: '#33425C',

  codeBg: '#0C111C',
  codeInk: '#D6DEEF',

  shadow1:
    '0 1px 2px -2px rgba(0,0,0,.64), 0 3px 6px 0 rgba(0,0,0,.48), 0 5px 12px 4px rgba(0,0,0,.36)',
  shadow2:
    '0 3px 6px -4px rgba(0,0,0,.48), 0 6px 16px 0 rgba(0,0,0,.32), 0 9px 28px 8px rgba(0,0,0,.20)',
  shadow3:
    '0 6px 16px -8px rgba(0,0,0,.32), 0 9px 28px 0 rgba(0,0,0,.20), 0 12px 48px 16px rgba(0,0,0,.12)',
};

export const colors = {
  light: lightColors,
  dark: darkColors,
} as const;

export interface MethodColorSet {
  get: string;
  post: string;
  put: string;
  patch: string;
  delete: string;
  head: string;
  options: string;
}

export interface ClassificationColor {
  color: string;
  background: string;
}

export function getMethodColors(mode: ThemeMode): MethodColorSet {
  const c = colors[mode];
  return {
    get: c.primary,
    post: c.success,
    put: c.warning,
    patch: c.purple,
    delete: c.error,
    head: c.muted,
    options: c.muted,
  };
}

export function getClassificationColors(
  mode: ThemeMode,
): Record<ClassificationLevel, ClassificationColor> {
  const c = colors[mode];
  return {
    l0: { color: c.muted, background: c.surface2 },
    l1: { color: c.info, background: c.infoBg },
    l2: { color: c.warning, background: c.warningBg },
    l3: { color: c.error, background: c.errorBg },
  };
}

/**
 * Ant Design 5 主题配置。
 * Seed 只负责品牌与基础尺度，Map / Alias 由算法生成后再做语义覆盖。
 */
export function getThemeConfig(mode: ThemeMode, density: Density = 'default'): ThemeConfig {
  const c = colors[mode];
  const baseAlgorithm =
    mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm;
  const algorithm =
    density === 'compact' ? [baseAlgorithm, antdTheme.compactAlgorithm] : [baseAlgorithm];

  return {
    algorithm,
    token: {
      colorPrimary: c.primary,
      colorPrimaryHover: c.primaryHover,
      colorPrimaryActive: c.primaryActive,
      colorPrimaryBg: c.primaryBg,
      colorPrimaryBgHover: mode === 'dark' ? c.primaryBorder : '#E3E6FF',
      colorPrimaryBorder: c.primaryBorder,

      colorLink: c.primary,
      colorLinkHover: c.primaryHover,
      colorLinkActive: c.primaryActive,

      colorSuccess: c.success,
      colorSuccessBg: c.successBg,
      colorSuccessBorder: c.successBorder,
      colorWarning: c.warning,
      colorWarningBg: c.warningBg,
      colorWarningBorder: c.warningBorder,
      colorError: c.error,
      colorErrorBg: c.errorBg,
      colorErrorBorder: c.errorBorder,
      colorInfo: c.info,
      colorInfoBg: c.infoBg,
      colorInfoBorder: c.infoBorder,

      colorBgBase: c.bg,
      colorTextBase: c.ink,
      colorBgLayout: c.bg,
      colorBgContainer: c.surface,
      colorBgElevated: mode === 'dark' ? c.surface2 : c.surface,

      colorBorder: c.lineStrong,
      colorBorderSecondary: c.line,
      colorSplit: c.line,

      colorText: c.ink,
      colorTextSecondary: c.muted,
      colorTextTertiary: c.faint,
      colorTextQuaternary: c.faint,

      colorFillSecondary: c.surface2,
      colorFillTertiary: c.surface2,
      colorFillQuaternary: c.surface3,

      fontFamily,
      fontFamilyCode,
      fontSize: typeScale.body,
      borderRadius: radius.md,
      borderRadiusLG: radius.lg,
      borderRadiusSM: radius.sm,
      controlHeight: densityControlHeight[density],
      lineWidth: 1,

      motionDurationFast: motion.fast,
      motionDurationMid: motion.base,
      motionDurationSlow: motion.slow,

      boxShadow: c.shadow2,
      boxShadowSecondary: c.shadow3,
      boxShadowTertiary: c.shadow1,
    },
    components: {
      Button: {
        fontWeight: 600,
        primaryShadow:
          mode === 'dark'
            ? '0 4px 14px rgba(129, 140, 248, 0.28)'
            : '0 4px 12px rgba(79, 70, 229, 0.22)',
        defaultShadow: 'none',
        defaultBorderColor: c.lineStrong,
        defaultColor: c.ink2,
      },
      Segmented: {
        trackBg: c.surface2,
        trackPadding: 3,
        itemColor: c.muted,
        itemHoverColor: c.ink,
        itemHoverBg: mode === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(19, 23, 34, 0.05)',
        itemActiveBg: mode === 'dark' ? 'rgba(255, 255, 255, 0.10)' : 'rgba(19, 23, 34, 0.08)',
        itemSelectedBg: c.primary,
        itemSelectedColor: mode === 'dark' ? '#0B1020' : '#FFFFFF',
      },
      Tabs: {
        inkBarColor: c.primary,
        itemSelectedColor: c.primary,
        itemHoverColor: c.primaryHover,
        itemColor: c.muted,
      },
      Tree: {
        nodeSelectedBg: c.primaryBg,
        nodeHoverBg: c.surface2,
      },
      Table: {
        headerBg: c.surface2,
        headerColor: c.muted,
        rowHoverBg: c.surface2,
        borderColor: c.line,
      },
      Modal: {
        footerBg: c.surface,
        titleFontSize: 16,
      },
      Input: {
        activeBorderColor: c.primary,
        hoverBorderColor: c.primaryHover,
        activeShadow: `0 0 0 3px ${c.primaryBg}`,
      },
      Select: {
        optionSelectedBg: c.primaryBg,
        optionActiveBg: c.surface2,
      },
      Menu: {
        itemSelectedBg: c.primaryBg,
        itemSelectedColor: c.primary,
      },
      Checkbox: {
        borderRadiusSM: radius.sm,
      },
      Switch: {
        colorPrimary: c.primary,
      },
      Tag: {
        defaultBg: c.surface2,
        defaultColor: c.muted,
      },
      Tooltip: {
        colorBgSpotlight: mode === 'dark' ? c.surface3 : c.ink,
      },
    },
  };
}

export const lightTheme = getThemeConfig('light');
export const darkTheme = getThemeConfig('dark');

/**
 * 供非 Ant 组件使用的 CSS 变量。
 * 建议在应用启动时先调用一次，避免首屏自定义组件闪色。
 */
export function getCssVars(
  mode: ThemeMode,
  density: Density = 'default',
): Record<string, string> {
  const c = colors[mode];
  const method = getMethodColors(mode);
  const classification = getClassificationColors(mode);

  return {
    '--aw-bg': c.bg,
    '--aw-surface': c.surface,
    '--aw-surface-2': c.surface2,
    '--aw-surface-3': c.surface3,
    '--aw-ink': c.ink,
    '--aw-ink-2': c.ink2,
    '--aw-muted': c.muted,
    '--aw-faint': c.faint,
    '--aw-line': c.line,
    '--aw-line-strong': c.lineStrong,

    '--aw-accent': c.primary,
    '--aw-accent-hover': c.primaryHover,
    '--aw-accent-active': c.primaryActive,
    '--aw-accent-soft': c.primaryBg,
    '--aw-accent-border': c.primaryBorder,
    '--aw-accent-2': c.accent2,
    '--aw-accent-2-soft': c.accent2Bg,
    '--aw-accent-gradient': `linear-gradient(135deg, ${c.primary} 0%, ${c.accent2} 100%)`,
    '--aw-accent-glow':
      mode === 'dark' ? 'rgba(129, 140, 248, 0.22)' : 'rgba(79, 70, 229, 0.16)',

    '--aw-success': c.success,
    '--aw-success-soft': c.successBg,
    '--aw-warning': c.warning,
    '--aw-warning-soft': c.warningBg,
    '--aw-error': c.error,
    '--aw-error-soft': c.errorBg,
    '--aw-info': c.info,
    '--aw-info-soft': c.infoBg,
    '--aw-purple': c.purple,
    '--aw-purple-soft': c.purpleBg,

    '--aw-code-bg': c.codeBg,
    '--aw-code-ink': c.codeInk,
    '--aw-shadow-1': c.shadow1,
    '--aw-shadow-2': c.shadow2,
    '--aw-shadow-3': c.shadow3,

    '--aw-method-get': method.get,
    '--aw-method-post': method.post,
    '--aw-method-put': method.put,
    '--aw-method-patch': method.patch,
    '--aw-method-delete': method.delete,

    '--aw-l0': classification.l0.color,
    '--aw-l0-bg': classification.l0.background,
    '--aw-l1': classification.l1.color,
    '--aw-l1-bg': classification.l1.background,
    '--aw-l2': classification.l2.color,
    '--aw-l2-bg': classification.l2.background,
    '--aw-l3': classification.l3.color,
    '--aw-l3-bg': classification.l3.background,

    '--aw-control-height': `${densityControlHeight[density]}px`,
    '--aw-radius-sm': `${radius.sm}px`,
    '--aw-radius-md': `${radius.md}px`,
    '--aw-radius-lg': `${radius.lg}px`,
    '--aw-radius-xl': `${radius.xl}px`,
    '--aw-font-ui': fontFamily,
    '--aw-font-code': fontFamilyCode,
  };
}
