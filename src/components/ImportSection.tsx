import React, { useState, useRef } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useApplicationRuntime } from '../contexts/RecordsContext';
import { decodeDocumentText } from '../utils/decodeDocumentText';
import { DocumentTooLargeError } from '../platform/contracts/files';
import { ChevronDown } from './icons';
import { settingsSection, rowBleed } from './SettingsListItem';

interface ImportSectionProps {
    onImportJson: (text: string) => boolean | Promise<boolean>;
    /** Replace every record and the calibration, not merge. */
    onReplaceJson: (text: string) => boolean | Promise<boolean>;
}

// Each row is one button, so the whole row takes the tap (as on Export).
const rowBase = 'w-full flex items-start justify-between py-[18px] text-start';
const rowLabel = 'block text-sm text-[var(--text)]';
const rowDesc = 'block text-xs text-[var(--text-muted)] mt-0.5';
const action = 'text-sm font-medium text-[var(--accent-ink)] shrink-0 ml-6 mt-0.5';

const ImportSection: React.FC<ImportSectionProps> = ({ onImportJson, onReplaceJson }) => {
    const { t } = useTranslation();
    const [showPaste, setShowPaste] = useState(false);
    const [text, setText] = useState('');
    const { showDialog } = useDialog();
    const runtime = useApplicationRuntime();
    const importing = useRef(false);
    const [busy, setBusy] = useState(false);
    const runImport = async (run: () => Promise<void>) => {
        if (importing.current) return;
        importing.current = true;
        setBusy(true);
        try {
            await run();
        } finally {
            importing.current = false;
            setBusy(false);
        }
    };
    const pickFile = (run: (text: string) => boolean | Promise<boolean>) =>
        runImport(async () => {
            try {
                const file = await runtime.filePicker.pick();
                if (file) await run(decodeDocumentText(file.bytes));
            } catch (error) {
                showDialog(
                    'alert',
                    t(error instanceof DocumentTooLargeError ? 'import.file_too_large' : 'import.file_read_failed'),
                );
            }
        });

    // The pasted text stays when the import doesn't go through (a Cancel at
    // "replace your records?", or a file it can't read), so it can be fixed
    // or tried again without pasting it all over.
    const importText = (run: (text: string) => boolean | Promise<boolean>) =>
        runImport(async () => {
            if (!(await run(text))) return;
            setText('');
            setShowPaste(false);
        });

    return (
        <div className={settingsSection}>
            {/* File import */}
            <button disabled={busy} onClick={() => void pickFile(onImportJson)} className={`${rowBase} ${rowBleed}`}>
                <span className={rowLabel}>{t('import.file')}</span>
                <span className={action}>{t('import.file_btn')}</span>
            </button>

            {/* Replace from a complete backup. Deliberately separate from the
                merge import: this is the only action that clears categories. */}
            <button disabled={busy} onClick={() => void pickFile(onReplaceJson)} className={`${rowBase} ${rowBleed}`}>
                <span>
                    <span className="block text-sm text-[var(--danger)]">{t('import.replace_complete_row')}</span>
                    <span className={rowDesc}>{t('import.replace_complete_desc')}</span>
                </span>
                <span className="text-sm font-medium text-[var(--danger)] shrink-0 ml-6 mt-0.5">
                    {t('import.replace_complete_file_btn')}
                </span>
            </button>

            {/* Paste JSON */}
            <div>
                <button
                    disabled={busy}
                    onClick={() => {
                        setShowPaste(v => !v);
                        setText('');
                    }}
                    aria-expanded={showPaste}
                    className={`${rowBase} ${rowBleed}`}
                >
                    <span>
                        <span className={rowLabel}>{t('import.text')}</span>
                        <span className={rowDesc}>{t('import.paste_hint')}</span>
                    </span>
                    <span className="shrink-0 ml-6 mt-0.5 p-1 text-[var(--text-muted)]">
                        <ChevronDown size={16} className={`chev ${showPaste ? 'rotate-180' : ''}`} />
                    </span>
                </button>

                {showPaste && (
                    <div className="pb-4 space-y-3">
                        <textarea
                            disabled={busy}
                            className="w-full h-28 p-3 bg-[var(--field)] border-(length:--hairline) border-[var(--border)] rounded-md outline-none focus:border-[var(--border-strong)] text-[var(--text)] placeholder:text-[var(--text-muted)] resize-none"
                            style={{ fontSize: '16px' }}
                            placeholder={t('import.paste_hint')}
                            value={text}
                            onChange={e => setText(e.target.value)}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                        />
                        <div className="flex justify-end gap-2">
                            {/* Red is for the confirm that follows, not the way to it. */}
                            <button
                                onClick={() => void importText(onReplaceJson)}
                                disabled={busy || !text.trim()}
                                className="btn-secondary"
                            >
                                {t('import.replace_complete_paste_btn')}
                            </button>
                            <button
                                onClick={() => void importText(onImportJson)}
                                disabled={busy || !text.trim()}
                                className="btn-primary"
                            >
                                {/* Plain "Import": the text can hold labs, weight and
                                    parameters as well as doses. */}
                                {t('import.btn')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ImportSection;
