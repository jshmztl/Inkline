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
  primary: '#2B4ACB',
  primaryHover: '#2F54EB',
  primaryActive: '#1D39C4',
  primaryBg: '#EDF1FD',
  primaryBorder: '#ADC6FF',

  success: '#389E0D',
  successBg: '#F6FFED',
  successBorder: '#B7EB8F',

  warning: '#AD6800',
  warningBg: '#FFF7E6',
  warningBorder: '#FFE7BA',

  error: '#CF1322',
  errorBg: '#FFF1F0',
  errorBorder: '#FFCCC7',

  info: '#006D75',
  infoBg: '#E6FFFB',
  infoBorder: '#87E8DE',

  purple: '#531DAB',
  purpleBg: '#F9F0FF',
  purpleBorder: '#D3ADF7',

  bg: '#ECEAE0',
  surface: '#FBFAF5',
  surface2: '#E3E3D6',
  surface3: '#D5D8C9',

  ink: '#1B211E',
  ink2: '#3A423E',
  muted: '#56605A',
  faint: '#737D77',
  line: '#CFD2C4',
  lineStrong: '#B7BDAD',

  codeBg: '#ECECE1',
  codeInk: '#2F3834',

  shadow1:
    '0 1px 2px -2px rgba(38,45,40,.16), 0 3px 6px 0 rgba(38,45,40,.12), 0 5px 12px 4px rgba(38,45,40,.09)',
  shadow2:
    '0 3px 6px -4px rgba(38,45,40,.12), 0 6px 16px 0 rgba(38,45,40,.08), 0 9px 28px 8px rgba(38,45,40,.05)',
  shadow3:
    '0 6px 16px -8px rgba(38,45,40,.08), 0 9px 28px 0 rgba(38,45,40,.05), 0 12px 48px 16px rgba(38,45,40,.03)',
} as const;

const darkColors: Record<keyof typeof lightColors, string> = {
  primary: '#7F9EF3',
  primaryHover: '#A8C1F8',
  primaryActive: '#5273E0',
  primaryBg: '#1D2A4D',
  primaryBorder: '#3E5FCB',

  success: '#6ABE39',
  successBg: '#1D3712',
  successBorder: '#306317',

  warning: '#E8B339',
  warningBg: '#2B2111',
  warningBorder: '#7C5914',

  error: '#E84749',
  errorBg: '#2A1215',
  errorBorder: '#791A1F',

  info: '#33BCB7',
  infoBg: '#112123',
  infoBorder: '#144848',

  purple: '#AB7AE0',
  purpleBg: '#1F1533',
  purpleBorder: '#3E2069',

  bg: '#090D12',
  surface: '#131A23',
  surface2: '#1B242F',
  surface3: '#25303D',

  ink: '#E6EBF3',
  ink2: '#C1C9D6',
  muted: '#A6B1C0',
  faint: '#8591A2',
  line: '#2A3340',
  lineStrong: '#3C4757',

  codeBg: '#070A0E',
  codeInk: '#D6DEEA',

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
        primaryShadow: 'none',
        defaultShadow: 'none',
      },
      Tabs: {
        inkBarColor: c.primary,
        itemSelectedColor: c.primary,
        itemHoverColor: c.primaryHover,
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
      },
      Input: {
        activeBorderColor: c.primary,
        hoverBorderColor: c.primaryHover,
        activeShadow: `0 0 0 3px ${c.primaryBg}`,
      },
      Select: {
        optionSelectedBg: c.primaryBg,
      },
      Menu: {
        itemSelectedBg: c.primaryBg,
        itemSelectedColor: c.primary,
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
