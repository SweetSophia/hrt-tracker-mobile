import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useApplicationRuntime } from '../contexts/RecordsContext';
import { DoseEvent, LabResult } from '../../logic';
import { Lock } from './icons';
import { CopyTick } from './Tick';
import { exportToCSV } from '../services/export';
import ReportOptions, { type ReportOptionsProps } from './ReportOptions';
import { defaultReportSelection } from '../reports/prepareReport';
import { settingsSection, rowBleed } from './SettingsListItem';
import { copyText } from '../utils/clipboard';
import { MIN_PASSWORD_LENGTH, newPasswordLevel } from '../../passwordStrength';
import PasswordStrengthHint from './PasswordStrengthHint';
import { SwapLabel } from './StableLabel';
import { useLauncherShortcutBlocker } from '../hooks/useLauncherShortcut';

import { EncryptedExportSession } from '../hooks/uiSession';

export interface ExportSectionProps extends Pick<
    ReportOptionsProps,
    'reportNow' | 'readOtherMode' | 'estimate' | 'estimateStatus' | 'onRetryEstimate'
> {
    events: DoseEvent[];
    labResults: LabResult[];
    weight: number;
    onExport: (encrypt: boolean, password?: string) => Promise<string | null>;
    /** The offline document picker can finish after this screen closes. */
    exportSession?: EncryptedExportSession;
    /** Copies the export to the clipboard. Resolving to false means the copy
     *  failed; nothing returned is taken as done. */
    onQuickExport?: () => void | boolean | Promise<void | boolean>;
    /** Plaintext complete-device bundle. Encryption belongs to the Tools workflow. */
    onExportCompleteBackup?: () => void;
}

// Each row is one button, so the whole row takes the tap, not only the
// 22px-tall accent words on the right, which stay as the row's label for
// what it does. Rows are divided the way Settings rows are.
const rowBase =
    'w-full flex items-start justify-between gap-3 py-[18px] text-start [overflow-wrap:anywhere] [&>span]:min-w-0';
const rowLabel = 'block text-sm text-[var(--text)]';
const rowDesc = 'block text-xs text-[var(--text-muted)] mt-0.5';
const action = 'max-w-[50%] shrink-0 text-end text-sm font-medium text-[var(--accent-ink)] mt-0.5';

const ExportSection: React.FC<ExportSectionProps> = ({
    events,
    labResults,
    weight,
    onExport,
    exportSession,
    onQuickExport,
    onExportCompleteBackup,
    reportNow,
    readOtherMode,
    estimate,
    estimateStatus,
    onRetryEstimate,
}) => {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();
    const runtime = useApplicationRuntime();
    const [screenExport] = useState(() => new EncryptedExportSession());
    const currentExport = exportSession ?? screenExport;
    const encryptedExport = useSyncExternalStore(currentExport.subscribe, currentExport.getSnapshot);
    const generatedPassword = encryptedExport?.status === 'saved' ? encryptedExport.password : null;
    const saving = encryptedExport?.status === 'saving';
    const passwordReady = generatedPassword !== null;
    const [showEncrypted, setShowEncrypted] = useState(saving);
    const [password, setPassword] = useState('');
    const [reportOpen, setReportOpen] = useState(false);
    const [reportSelection, setReportSelection] = useState(defaultReportSelection);
    const reportId = useId();
    const [reportSaving, setReportSaving] = useState(false);
    const hasData = events.length > 0 || labResults.length > 0;
    const showEncryptedRow = hasData || encryptedExport !== undefined;
    const encryptedPanelOpen = showEncrypted || encryptedExport !== undefined;
    useLauncherShortcutBlocker(encryptedExport !== undefined || (hasData && showEncrypted && password !== ''));
    const encryptedFormRef = useRef<HTMLDivElement>(null);
    const encryptedRowRef = useRef<HTMLButtonElement>(null);
    const backupRowRef = useRef<HTMLButtonElement>(null);
    const passwordHeadingRef = useRef<HTMLHeadingElement>(null);
    const hadEncryptedRow = useRef(showEncryptedRow);
    useEffect(() => {
        const active = document.activeElement;
        if (passwordReady && (active === document.body || encryptedFormRef.current?.contains(active))) {
            passwordHeadingRef.current?.focus();
        }
        if (hadEncryptedRow.current && !showEncryptedRow && active === document.body) {
            backupRowRef.current?.focus();
        }
        hadEncryptedRow.current = showEncryptedRow;
    }, [passwordReady, showEncryptedRow]);
    const [copied, setCopied] = useState(false);
    const [jsonCopied, setJsonCopied] = useState(false);
    // Which copy last failed, if any. A tick only ever means the clipboard
    // really has it: a password shown as copied when it wasn't is a backup
    // nobody can open.
    const [copyFailed, setCopyFailed] = useState<'json' | 'password' | null>(null);

    // The file this password protects is downloaded and attacked offline, so
    // it gets the same floor the account password does. An empty field means
    // "generate one for me" and stays allowed.
    const level = newPasswordLevel(password);
    const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
    const passwordBlocked = tooShort || level === 'weak' || level === 'tooLong';

    const closeEncryptedPanel = () => {
        setPassword('');
        setShowEncrypted(false);
    };

    const handleJsonExport = async () => {
        await onExport(false);
    };

    const handleEncryptedExport = async () => {
        if (passwordBlocked) return;
        const pending = { status: 'saving' } as const;
        if (!currentExport.replace(undefined, pending)) return;
        setCopyFailed(null);
        try {
            const generated = await onExport(true, password || undefined);
            currentExport.replace(pending, generated ? { status: 'saved', password: generated } : undefined);
        } finally {
            currentExport.replace(pending);
        }
    };

    const handleCopyPassword = async () => {
        if (!generatedPassword) return;
        setCopyFailed(null);
        try {
            await copyText(generatedPassword);
        } catch {
            setCopied(false);
            setCopyFailed('password');
            return;
        }
        setCopyFailed(null);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleCopyJson = async () => {
        if (!onQuickExport) return;
        setCopyFailed(null);
        setJsonCopied(false);
        let ok: void | boolean;
        try {
            ok = await onQuickExport();
        } catch {
            ok = false;
        }
        if (ok === false) {
            setJsonCopied(false);
            setCopyFailed('json');
            return;
        }
        setCopyFailed(null);
        setJsonCopied(true);
        setTimeout(() => setJsonCopied(false), 2000);
    };

    const handleCsvExport = () => {
        const csv = exportToCSV({ events, labResults, weight, lang, t });
        void runtime.files
            .save({
                name: `hrt-data-${new Date().toISOString().split('T')[0]}.csv`,
                mimeType: 'text/csv;charset=utf-8;',
                bytes: new TextEncoder().encode(csv),
            })
            .catch(() => {
                showDialog('alert', t('export.file_failed'));
            });
    };

    return (
        <>
            <div className={settingsSection}>
                {/* Complete backup. Deliberately unencrypted: the Tools workflow
                    owns OpenPGP and never receives keys or passphrases from us. */}
                {onExportCompleteBackup && (
                    <button ref={backupRowRef} onClick={onExportCompleteBackup} className={`${rowBase} ${rowBleed}`}>
                        <span>
                            <span className={rowLabel}>{t('export.complete_title')}</span>
                            <span className={rowDesc}>{t('export.complete_desc')}</span>
                        </span>
                        <span className={action}>{t('export.complete_btn')}</span>
                    </button>
                )}

                {hasData && (
                    <>
                        {/* JSON */}
                        <button onClick={handleJsonExport} className={`${rowBase} ${rowBleed}`}>
                            <span>
                                <span className={rowLabel}>JSON</span>
                                <span className={rowDesc}>{t('drawer.save_hint')}</span>
                            </span>
                            <span className={action}>{t('export.btn_json')}</span>
                        </button>

                        {/* Copy JSON */}
                        {onQuickExport && (
                            <button onClick={handleCopyJson} className={`${rowBase} ${rowBleed}`}>
                                <span>
                                    <span className={rowLabel}>{t('export.btn_copy_json')}</span>
                                    <span className={rowDesc}>
                                        {copyFailed === 'json' ? t('export.copy_failed') : t('export.copy_desc')}
                                    </span>
                                </span>
                                <span className={`${action} flex items-center gap-1`}>
                                    <CopyTick copied={jsonCopied} size={13} />
                                    <SwapLabel
                                        show={jsonCopied}
                                        off={t('btn.copy')}
                                        on={t('export.copied')}
                                        fit
                                        align="end"
                                    />
                                </span>
                            </button>
                        )}
                    </>
                )}

                {/* Keep the panel open during a save and until the generated password is acknowledged. */}
                {showEncryptedRow && (
                    <div ref={encryptedFormRef}>
                        <button
                            ref={encryptedRowRef}
                            onClick={() => {
                                if (encryptedExport) return;
                                if (showEncrypted) closeEncryptedPanel();
                                else setShowEncrypted(true);
                            }}
                            aria-expanded={encryptedPanelOpen}
                            aria-disabled={encryptedExport ? true : undefined}
                            className={`${rowBase} ${encryptedExport ? 'row-bleed cursor-default' : rowBleed}`}
                        >
                            <span>
                                <span className={rowLabel}>{`JSON (${t('export.encrypt_label')})`}</span>
                                <span className={rowDesc}>{t('export.encrypt_ask_desc')}</span>
                            </span>
                            {!encryptedExport && (
                                <span className={action}>
                                    <SwapLabel
                                        show={showEncrypted}
                                        off={t('export.btn_encrypted')}
                                        on={t('btn.cancel')}
                                        align="end"
                                    />
                                </span>
                            )}
                        </button>

                        {encryptedPanelOpen && (
                            <div className="pb-[18px] space-y-3">
                                {!generatedPassword && (
                                    <>
                                        <div className="relative">
                                            <input
                                                type="password"
                                                name="export-encryption-password"
                                                value={password}
                                                onChange={e => setPassword(e.target.value)}
                                                placeholder={t('export.password_placeholder')}
                                                className="input-base w-full pl-9 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)]"
                                                disabled={saving}
                                                autoComplete="new-password"
                                                autoCorrect="off"
                                                autoCapitalize="off"
                                                spellCheck={false}
                                            />
                                            <Lock
                                                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                                                size={14}
                                            />
                                        </div>
                                        <p className="text-xs text-[var(--text-muted)]">
                                            {t('export.password_hint_random')}
                                        </p>
                                        <PasswordStrengthHint level={tooShort ? 'tooShort' : level} />
                                        <button
                                            onClick={handleEncryptedExport}
                                            disabled={passwordBlocked}
                                            aria-disabled={saving || undefined}
                                            aria-busy={saving || undefined}
                                            className="btn-primary w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                                        >
                                            {t('export.btn_encrypted')}
                                        </button>
                                    </>
                                )}

                                {generatedPassword && (
                                    <div className="mt-2 border-(length:--hairline) border-[var(--border)] rounded-lg p-3 space-y-2">
                                        <h2
                                            ref={passwordHeadingRef}
                                            tabIndex={-1}
                                            className="text-xs font-semibold text-[var(--text)]"
                                        >
                                            {t('export.password_title')}
                                        </h2>
                                        <p className="text-xs text-[var(--text-muted)]">{t('export.password_desc')}</p>
                                        <div className="flex items-center gap-2 bg-[var(--surface-hover)] rounded-md px-3 py-2">
                                            <span className="font-mono text-sm text-[var(--text)] flex-1 select-all break-all">
                                                {generatedPassword}
                                            </span>
                                            <button
                                                onClick={handleCopyPassword}
                                                aria-label={copied ? t('export.copied') : t('btn.copy')}
                                                className="tap-target shrink-0 p-1 text-[var(--text-muted)]"
                                            >
                                                <CopyTick copied={copied} size={14} />
                                            </button>
                                        </div>
                                        {copyFailed === 'password' && (
                                            <p className="text-xs text-[var(--text-muted)]">
                                                {t('export.copy_failed')}
                                            </p>
                                        )}
                                        <button
                                            onClick={() => {
                                                (hasData ? encryptedRowRef : backupRowRef).current?.focus();
                                                currentExport.replace(encryptedExport);
                                                setCopied(false);
                                                setCopyFailed(null);
                                                closeEncryptedPanel();
                                            }}
                                            className="tap-target w-full py-1.5 text-xs text-[var(--text-muted)]"
                                        >
                                            {t('btn.ok')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {hasData && (
                    <>
                        {/* CSV */}
                        <button onClick={handleCsvExport} className={`${rowBase} ${rowBleed}`}>
                            <span>
                                <span className={rowLabel}>CSV</span>
                                <span className={rowDesc}>{t('export.csv_desc')}</span>
                            </span>
                            <span className={action}>{t('export.btn_csv')}</span>
                        </button>
                    </>
                )}
                <button
                    type="button"
                    className={`${rowBase} ${rowBleed}`}
                    disabled={reportSaving}
                    aria-expanded={reportOpen}
                    aria-controls={reportId}
                    onClick={() => setReportOpen(open => !open)}
                >
                    <span className={rowLabel}>PDF</span>
                    <span className={action}>{t('report.configure')}</span>
                </button>
                <div id={reportId} hidden={!reportOpen}>
                    {reportOpen && (
                        <ReportOptions
                            saving={reportSaving}
                            onSavingChange={setReportSaving}
                            events={events}
                            labResults={labResults}
                            reportNow={reportNow}
                            estimate={estimate}
                            estimateStatus={estimateStatus}
                            onRetryEstimate={onRetryEstimate}
                            readOtherMode={readOtherMode}
                            selection={reportSelection}
                            onSelectionChange={fields => setReportSelection(previous => ({ ...previous, ...fields }))}
                        />
                    )}
                </div>
            </div>

            {/* Where a copy's result is announced, failed or done. It stays
                mounted, outside the rows, because a button's contents are read
                as its name rather than as news, and a region that appears
                already filled is often not read at all. It is emptied before
                each try, so a second result is heard again. */}
            <p className="sr-only" role="status">
                {passwordReady ? t('export.password_ready') : ''}
            </p>
            {(hasData || encryptedExport) && (
                <p className="sr-only" role="status">
                    {copyFailed ? t('export.copy_failed') : jsonCopied ? t('export.copied') : ''}
                </p>
            )}
        </>
    );
};

export default ExportSection;
