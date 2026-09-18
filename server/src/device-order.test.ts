import { describe, expect, it } from 'vitest';
import { compareDeviceModels } from '@fmp/shared';

const apple = (name: string) => ({ brand: 'Apple', family: 'iPhone', name });

describe('device model ordering', () => {
  it('orders iPhones by generation, then base, mini/e, Plus, Air, Pro, Pro Max', () => {
    const names = [
      'iPhone 17 Pro Max', 'iPhone 11 Pro', 'iPhone XS Max', 'iPhone 12 mini', 'iPhone 8 Plus', 'iPhone SE (2020)', 'iPhone 11',
      'iPhone 16e', 'iPhone 17 Air', 'iPhone X', 'iPhone 12', 'iPhone 11 Pro Max', 'iPhone 6S', 'iPhone XR', 'iPhone 16', 'iPhone 6S Plus',
      'iPhone SE (2022)', 'iPhone 13', 'iPhone 17', 'iPhone 8', 'iPhone 16 Plus', 'iPhone 12 Pro', 'iPhone 7', 'iPhone XS', 'iPhone 14',
      'iPhone 16 Pro', 'iPhone 16 Pro Max', 'iPhone 17 Pro',
    ];
    const sorted = names.map(apple).sort(compareDeviceModels).map((m) => m.name);
    expect(sorted).toEqual([
      'iPhone 6S', 'iPhone 6S Plus', 'iPhone 7', 'iPhone 8', 'iPhone 8 Plus',
      'iPhone X', 'iPhone XR', 'iPhone XS', 'iPhone XS Max',
      'iPhone 11', 'iPhone 11 Pro', 'iPhone 11 Pro Max', 'iPhone SE (2020)',
      'iPhone 12', 'iPhone 12 mini', 'iPhone 12 Pro', 'iPhone 13', 'iPhone SE (2022)', 'iPhone 14',
      'iPhone 16', 'iPhone 16e', 'iPhone 16 Plus', 'iPhone 16 Pro', 'iPhone 16 Pro Max',
      'iPhone 17', 'iPhone 17 Air', 'iPhone 17 Pro', 'iPhone 17 Pro Max',
    ]);
  });

  it('sorts other brands naturally with numbers compared as numbers', () => {
    const models = [
      { brand: 'Samsung', family: 'Galaxy A', name: 'Galaxy A13' },
      { brand: 'Samsung', family: 'Galaxy A', name: 'Galaxy A02s' },
      { brand: 'Samsung', family: 'Galaxy S', name: 'Galaxy S22 Ultra' },
      { brand: 'Samsung', family: 'Galaxy A', name: 'Galaxy A2' },
      { brand: 'Apple', family: 'iPad', name: 'iPad 10' },
      { brand: 'Apple', family: 'iPad', name: 'iPad 9' },
      { brand: 'Apple', family: 'iPad', name: 'iPad Air 5' },
    ];
    expect(models.sort(compareDeviceModels).map((m) => m.name)).toEqual([
      'iPad 9', 'iPad 10', 'iPad Air 5', 'Galaxy A2', 'Galaxy A02s', 'Galaxy A13', 'Galaxy S22 Ultra',
    ]);
  });
});
