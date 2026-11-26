import type { ColorPalette } from '../appearance/palettes';
import type { Lang } from './translations';

type AppearanceKey =
    | 'appearance.display_mode'
    | 'appearance.color_theme'
    | 'appearance.color_theme_mono'
    | `appearance.palette.${ColorPalette}`;

export const APPEARANCE_COPY: Record<Lang, Record<AppearanceKey, string>> = {
    zh: {
        'appearance.display_mode': '显示模式',
        'appearance.color_theme': '主题配色',
        'appearance.color_theme_mono': '切换到其他显示模式后，会恢复你保存的主题配色。',
        'appearance.palette.terracotta': '陶土色',
        'appearance.palette.plum': '梅紫色',
        'appearance.palette.teal': '青绿色',
    },
    'zh-TW': {
        'appearance.display_mode': '顯示模式',
        'appearance.color_theme': '主題配色',
        'appearance.color_theme_mono': '切換到其他顯示模式後，就會恢復你儲存的主題配色。',
        'appearance.palette.terracotta': '陶土色',
        'appearance.palette.plum': '梅紫色',
        'appearance.palette.teal': '青綠色',
    },
    yue: {
        'appearance.display_mode': '顯示模式',
        'appearance.color_theme': '主題配色',
        'appearance.color_theme_mono': '轉去其他顯示模式，就會用返你儲存嘅主題配色。',
        'appearance.palette.terracotta': '陶土色',
        'appearance.palette.plum': '梅紫色',
        'appearance.palette.teal': '青綠色',
    },
    en: {
        'appearance.display_mode': 'Display mode',
        'appearance.color_theme': 'Color theme',
        'appearance.color_theme_mono': 'Your saved color theme returns when you switch to another display mode.',
        'appearance.palette.terracotta': 'Terracotta',
        'appearance.palette.plum': 'Plum',
        'appearance.palette.teal': 'Teal',
    },
    ja: {
        'appearance.display_mode': '表示モード',
        'appearance.color_theme': 'カラーテーマ',
        'appearance.color_theme_mono': '別の表示モードに切り替えると、保存したカラーテーマに戻ります。',
        'appearance.palette.terracotta': 'テラコッタ',
        'appearance.palette.plum': 'プラム',
        'appearance.palette.teal': 'ティール',
    },
    ko: {
        'appearance.display_mode': '화면 모드',
        'appearance.color_theme': '색상 테마',
        'appearance.color_theme_mono': '다른 화면 모드로 바꾸면 저장한 색상 테마가 다시 적용됩니다.',
        'appearance.palette.terracotta': '테라코타',
        'appearance.palette.plum': '자두색',
        'appearance.palette.teal': '청록색',
    },
    tr: {
        'appearance.display_mode': 'Görünüm modu',
        'appearance.color_theme': 'Renk teması',
        'appearance.color_theme_mono': 'Başka bir görünüm moduna geçtiğinizde kayıtlı renk temanız yeniden uygulanır.',
        'appearance.palette.terracotta': 'Terrakota',
        'appearance.palette.plum': 'Erik moru',
        'appearance.palette.teal': 'Petrol yeşili',
    },
    ru: {
        'appearance.display_mode': 'Режим оформления',
        'appearance.color_theme': 'Цветовая тема',
        'appearance.color_theme_mono': 'При смене режима оформления сохранённая цветовая тема снова применится.',
        'appearance.palette.terracotta': 'Терракотовый',
        'appearance.palette.plum': 'Сливовый',
        'appearance.palette.teal': 'Сине-зелёный',
    },
    uk: {
        'appearance.display_mode': 'Режим оформлення',
        'appearance.color_theme': 'Колірна тема',
        'appearance.color_theme_mono':
            'Збережена колірна тема повернеться після перемикання на інший режим оформлення.',
        'appearance.palette.terracotta': 'Теракотовий',
        'appearance.palette.plum': 'Сливовий',
        'appearance.palette.teal': 'Синьо-зелений',
    },
};
