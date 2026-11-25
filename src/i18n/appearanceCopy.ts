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
        'appearance.color_theme_mono': '选浅色模式、深色模式或跟随系统，就能使用主题配色。',
        'appearance.palette.terracotta': '陶土色',
        'appearance.palette.plum': '梅紫色',
        'appearance.palette.teal': '青绿色',
    },
    'zh-TW': {
        'appearance.display_mode': '顯示模式',
        'appearance.color_theme': '主題配色',
        'appearance.color_theme_mono': '選擇淺色、深色或跟隨系統，就能使用主題配色。',
        'appearance.palette.terracotta': '陶土色',
        'appearance.palette.plum': '梅紫色',
        'appearance.palette.teal': '青綠色',
    },
    yue: {
        'appearance.display_mode': '顯示模式',
        'appearance.color_theme': '主題配色',
        'appearance.color_theme_mono': '揀淺色、深色或者跟隨系統，就可以用主題配色。',
        'appearance.palette.terracotta': '陶土色',
        'appearance.palette.plum': '梅紫色',
        'appearance.palette.teal': '青綠色',
    },
    en: {
        'appearance.display_mode': 'Display mode',
        'appearance.color_theme': 'Color theme',
        'appearance.color_theme_mono': 'Choose Light, Dark, or System to use a color theme.',
        'appearance.palette.terracotta': 'Terracotta',
        'appearance.palette.plum': 'Plum',
        'appearance.palette.teal': 'Teal',
    },
    ja: {
        'appearance.display_mode': '表示モード',
        'appearance.color_theme': 'カラーテーマ',
        'appearance.color_theme_mono': 'カラーテーマを使うには、ライト、ダーク、システムのいずれかを選んでください。',
        'appearance.palette.terracotta': 'テラコッタ',
        'appearance.palette.plum': 'プラム',
        'appearance.palette.teal': 'ティール',
    },
    ko: {
        'appearance.display_mode': '화면 모드',
        'appearance.color_theme': '색상 테마',
        'appearance.color_theme_mono': '색상 테마를 사용하려면 밝게, 어둡게 또는 시스템을 선택하세요.',
        'appearance.palette.terracotta': '테라코타',
        'appearance.palette.plum': '자두색',
        'appearance.palette.teal': '청록색',
    },
    tr: {
        'appearance.display_mode': 'Görünüm modu',
        'appearance.color_theme': 'Renk teması',
        'appearance.color_theme_mono': 'Renk temasını kullanmak için Açık, Koyu veya Sistem moduna geçin.',
        'appearance.palette.terracotta': 'Terrakota',
        'appearance.palette.plum': 'Erik moru',
        'appearance.palette.teal': 'Petrol yeşili',
    },
    ru: {
        'appearance.display_mode': 'Режим оформления',
        'appearance.color_theme': 'Цветовая тема',
        'appearance.color_theme_mono':
            'Чтобы применить цветовую тему, выберите «Светлое», «Тёмное» или «Как в системе».',
        'appearance.palette.terracotta': 'Терракотовый',
        'appearance.palette.plum': 'Сливовый',
        'appearance.palette.teal': 'Сине-зелёный',
    },
    uk: {
        'appearance.display_mode': 'Режим оформлення',
        'appearance.color_theme': 'Колірна тема',
        'appearance.color_theme_mono': 'Щоб застосувати колірну тему, виберіть «Світле», «Темне» або «Як у системі».',
        'appearance.palette.terracotta': 'Теракотовий',
        'appearance.palette.plum': 'Сливовий',
        'appearance.palette.teal': 'Синьо-зелений',
    },
};
