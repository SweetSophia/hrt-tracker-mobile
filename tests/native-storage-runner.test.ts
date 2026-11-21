import { describe, expect, it } from 'vitest';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from '../scripts/mobile/run-native-storage-qualification.mjs';

const success = `INSTRUMENTATION_STATUS: class=example.Test
INSTRUMENTATION_STATUS: numtests=1
INSTRUMENTATION_STATUS: test=roundTrip
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_STATUS: class=example.Test
INSTRUMENTATION_STATUS: numtests=1
INSTRUMENTATION_STATUS: test=roundTrip
INSTRUMENTATION_STATUS_CODE: 0
INSTRUMENTATION_RESULT: stream=
OK (1 test)
INSTRUMENTATION_CODE: -1
`;

describe('native storage qualification runner', () => {
    it('accepts the measured page size required by each dedicated AVD', () => {
        expect(() => validateQualificationEnvironment('HRT_Feasibility_API36', 4096)).not.toThrow();
        expect(() => validateQualificationEnvironment('HRT_Feasibility_16KB', 16384)).not.toThrow();
    });

    it('rejects a misconfigured 16 KB AVD or an unknown environment', () => {
        expect(() => validateQualificationEnvironment('HRT_Feasibility_16KB', 4096)).toThrow();
        expect(() => validateQualificationEnvironment('HRT_Feasibility_API36', 16384)).toThrow();
        expect(() => validateQualificationEnvironment('unknown', 16384)).toThrow();
        expect(() => validateQualificationEnvironment('HRT_Feasibility_16KB', NaN)).toThrow();
    });
    it('scopes every command to an explicitly selected emulator', () => {
        expect(qualificationAdbArgs('emulator-5580', ['shell', 'getconf', 'PAGE_SIZE'])).toEqual([
            '-s',
            'emulator-5580',
            'shell',
            'getconf',
            'PAGE_SIZE',
        ]);
        for (const serial of ['', undefined, '-e', 'physical-phone', 'emulator-1;reboot']) {
            expect(() => qualificationAdbArgs(serial, ['shell', 'reboot'])).toThrow();
        }
    });

    it('accepts only an actual completed test result', () => {
        expect(instrumentationCases(success)).toEqual([{ className: 'example.Test', name: 'roundTrip' }]);
    });

    it.each([
        '',
        'INSTRUMENTATION_CODE: -1\n',
        success.replace('OK (1 test)', 'OK (2 tests)'),
        success.replace('INSTRUMENTATION_STATUS_CODE: 0', 'INSTRUMENTATION_STATUS_CODE: -2'),
        success.replace('INSTRUMENTATION_STATUS_CODE: 0', 'INSTRUMENTATION_STATUS_CODE: -3'),
        success + 'INSTRUMENTATION_FAILED: Process crashed\n',
        success.replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0'),
        success + success,
    ])('rejects empty, partial, failed, skipped or duplicate results', output => {
        expect(() => instrumentationCases(output)).toThrow();
    });
});
