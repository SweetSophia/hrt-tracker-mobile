import { useTranslation } from '../contexts/LanguageContext';
import type { AppModelStatus } from '../hooks/appModelTypes';

/** Estimates can fail independently of record editing and navigation. */
export function ModelStatus({ status, onRetry }: { status: AppModelStatus; onRetry(): void }) {
    const { t } = useTranslation();
    if (status === 'ready') return null;
    return (
        <div
            className="w-full max-w-2xl mx-auto px-6 md:px-8 py-6 text-sm text-[var(--text-muted)]"
            role={status === 'error' ? 'alert' : 'status'}
        >
            <p>{t(status === 'error' ? 'model.error' : 'model.loading')}</p>
            {status === 'error' && (
                <button className="btn-secondary mt-4" onClick={onRetry}>
                    {t('model.retry')}
                </button>
            )}
        </div>
    );
}
