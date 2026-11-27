import { DoseEvent, LabResult, activeCompoundName, isT_LabUnit } from '../../logic';
import { formatDate } from '../utils/helpers';
import type { Lang } from '../i18n/translations';

// Define the type for user-friendly export data
interface ExportData {
    events: DoseEvent[];
    labResults: LabResult[];
    weight: number;
    lang: Lang;
    t: (key: string) => string;
}

export const exportToCSV = (data: ExportData): string => {
    const { events, labResults, lang, t } = data;
    const rows = [];

    // Header
    rows.push([
        t('export.col.type'),
        t('export.col.date'),
        t('export.col.item'),
        t('export.col.value'),
        t('export.col.unit'),
        t('export.col.route_ester'),
    ]);

    // Events
    events.forEach(e => {
        const date = formatDate(new Date(e.timeH * 3600000), lang);
        rows.push([t('export.val.dose'), date, activeCompoundName(e.ester), e.doseMG, 'mg', `${e.route} - ${e.ester}`]);
    });

    // Labs
    labResults.forEach(l => {
        const date = formatDate(new Date(l.timeH * 3600000), lang);
        rows.push([
            t('export.val.lab'),
            date,
            isT_LabUnit(l.unit) ? 'Testosterone' : 'Estradiol',
            l.concValue,
            l.unit,
            '-',
        ]);
    });

    return rows.map(r => r.join(',')).join('\n');
};
