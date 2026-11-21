import React from 'react';
import PageHeader, { PAGE_COLUMN } from '../components/PageHeader';

import { useTranslation } from '../contexts/LanguageContext';
import ExportSection, { type ExportSectionProps } from '../components/ExportSection';

interface ExportSettingsProps extends ExportSectionProps {
    onBack: () => void;
}

const ExportSettings: React.FC<ExportSettingsProps> = ({ onBack, ...exportProps }) => {
    const { t } = useTranslation();

    return (
        <div className="relative space-y-4 md:pb-32">
            <PageHeader onBack={onBack} title={t('export.title')} />

            <div className={PAGE_COLUMN}>
                <ExportSection {...exportProps} />
            </div>
        </div>
    );
};

export default ExportSettings;
