import { describe, expect, it } from 'vitest';
import { COLOR_PALETTES, isColorPalette, type ColorPalette } from '../../src/appearance/palettes';

describe('color palettes', () => {
    it('lists the agreed palettes in display order', () => {
        expect([...COLOR_PALETTES]).toEqual(['terracotta', 'plum', 'teal']);
    });

    it('accepts exactly the palette names for the portable preference', () => {
        const palettes: ColorPalette[] = ['terracotta', 'plum', 'teal'];
        for (const palette of palettes) expect(isColorPalette(palette)).toBe(true);
        for (const rejected of [
            'blue',
            'TERRACOTTA',
            '',
            ' terracotta',
            42,
            null,
            undefined,
            true,
            ['teal'],
            { palette: 'teal' },
        ]) {
            expect(isColorPalette(rejected)).toBe(false);
        }
    });
});
