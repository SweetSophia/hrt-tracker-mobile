import React from 'react';
import { COLOR_PALETTES, type ColorPalette } from '../appearance/palettes';
import PageHeader, { PAGE_COLUMN } from '../components/PageHeader';
import Tick from '../components/Tick';
import { useTranslation } from '../contexts/LanguageContext';
import { APP_THEMES, type AppTheme } from '../constants';

interface AppearanceSettingsProps {
    theme: AppTheme;
    setTheme: (theme: AppTheme) => void;
    palette: ColorPalette;
    setPalette: (palette: ColorPalette) => void;
    onBack: () => void;
}

const ROW =
    'flex min-h-12 w-full items-center justify-between gap-3 border-b-(length:--hairline) border-[var(--border)] py-3 text-start text-sm text-[var(--text)] last:border-b-0';

const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({ theme, setTheme, palette, setPalette, onBack }) => {
    const { t } = useTranslation();
    const paletteDisabled = theme === 'mono';

    return (
        <div className="relative space-y-4 md:pb-32">
            <PageHeader onBack={onBack} title={t('settings.theme')} />

            <div className={`${PAGE_COLUMN} space-y-6`}>
                <section aria-labelledby="appearance-display-mode">
                    <h2 className="group-heading" id="appearance-display-mode">
                        {t('appearance.display_mode')}
                    </h2>
                    {APP_THEMES.map(value => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setTheme(value)}
                            aria-pressed={theme === value}
                            className={ROW}
                        >
                            <span className={theme === value ? 'font-semibold' : undefined}>{t(`theme.${value}`)}</span>
                            <Tick on={theme === value} />
                        </button>
                    ))}
                </section>

                <section
                    aria-labelledby="appearance-color-theme"
                    aria-describedby={paletteDisabled ? 'appearance-color-theme-note' : undefined}
                >
                    <h2 className="group-heading" id="appearance-color-theme">
                        {t('appearance.color_theme')}
                    </h2>
                    {paletteDisabled && (
                        <p className="mt-1 text-sm text-[var(--text-muted)]" id="appearance-color-theme-note">
                            {t('appearance.color_theme_mono')}
                        </p>
                    )}
                    {COLOR_PALETTES.map(value => {
                        const selected = !paletteDisabled && palette === value;
                        return (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setPalette(value)}
                                aria-pressed={paletteDisabled ? undefined : selected}
                                disabled={paletteDisabled}
                                className={`${ROW} disabled:text-[var(--text-muted)]`}
                            >
                                <span className={`flex items-center gap-3 ${selected ? 'font-semibold' : ''}`}>
                                    <span
                                        aria-hidden="true"
                                        className="size-4 shrink-0 rounded-full"
                                        style={{ backgroundColor: `var(--palette-swatch-${value})` }}
                                    />
                                    {t(`appearance.palette.${value}`)}
                                </span>
                                <Tick on={selected} />
                            </button>
                        );
                    })}
                </section>
            </div>
        </div>
    );
};

export default AppearanceSettings;
