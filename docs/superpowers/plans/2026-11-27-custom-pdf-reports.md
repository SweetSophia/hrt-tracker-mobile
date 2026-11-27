# Custom PDF reports

People can prepare a report for an appointment using a date range, selected medications and measured estradiol or testosterone. They can preview the selection and add measured graphs or a separately labeled estimate from Overview. The PDF follows the app language and is generated offline.

## Implementation

1. Define shared report types in `src/reports/types.ts`. Build one selection function for preview and PDF. Test inclusive local calendar days, a dose change within one medication, patch removal, mixed lab units and out-of-range records.
2. Render searchable, paginated tables and optional graphs in the existing PDF workflow. Keep the recorded units in the lab table. Plot each hormone in a consistent unit. Draw estimates from the active mode's ready Overview simulation, using its full history and calibration, clipped to the selected dates and current time.
3. Open the report options from Settings. Default to the current mode and the past 90 days. Read the other mode for the same account only after explicit selection. Show the dates, medications, counts and graph choices before saving. Continue using the runtime file picker.
4. Translate the controls and report text for every app language. Check synthetic English and non-Latin PDFs and a long report in a PDF viewer. Run the unit, browser and mobile build checks and review the complete diff before opening a PR.
