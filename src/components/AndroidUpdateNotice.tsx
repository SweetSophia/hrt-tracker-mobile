import { useTranslation } from '../contexts/LanguageContext';
import type { AndroidUpdates } from '../hooks/useAndroidUpdates';
import { fill } from '../utils/regimenText';
import { headerAction, headerActionAccent, PAGE_COLUMN } from './PageHeader';

export default function AndroidUpdateNotice({ updates }: { updates: AndroidUpdates }) {
    const { t } = useTranslation();
    const { noticeVersion, pending, failure } = updates;
    if (!noticeVersion) return null;

    return (
        <div className={`${PAGE_COLUMN} shrink-0 py-1 text-sm text-[var(--text)]`}>
            <div className="flex flex-wrap items-center justify-between gap-x-2">
                <p role="status" className="min-w-0 break-words">
                    {fill(t('androidUpdate.available'), { version: noticeVersion })}
                </p>
                <div className="flex flex-wrap items-center gap-x-1">
                    <button
                        type="button"
                        disabled={!!pending}
                        onClick={() => updates.openRelease(noticeVersion, 'notice')}
                        className={`${headerActionAccent} min-h-11 disabled:opacity-60`}
                    >
                        {t('androidUpdate.view')}
                    </button>
                    <button
                        type="button"
                        disabled={!!pending}
                        onClick={() => updates.dismiss(noticeVersion)}
                        className={`${headerAction} min-h-11 disabled:opacity-60`}
                    >
                        {t('update.later')}
                    </button>
                </div>
            </div>
            <p aria-live="polite" className="text-[var(--text-muted)]">
                {failure === 'openInNotice' && t('androidUpdate.openError')}
                {failure === 'dismiss' && t('androidUpdate.dismissError')}
            </p>
        </div>
    );
}
