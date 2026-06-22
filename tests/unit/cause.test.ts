/**
 * Tests for cancellation cause classification.
 * Uses real German strings (with umlauts) to exercise the umlaut-aware normalization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyCause } from '../../src/cause.js';

describe('classifyCause - categories', () => {
  it('classifies personnel shortage', () => {
    assert.strictEqual(classifyCause('Fahrtausfälle wegen Personalmangel'), 'personnel');
    assert.strictEqual(classifyCause('krankheitsbedingter Ausfall'), 'personnel');
    assert.strictEqual(classifyCause('Engpass beim Fahrpersonal'), 'personnel');
    assert.strictEqual(classifyCause('betriebsbedingte Fahrtausfälle'), 'personnel');
  });

  it('classifies strike', () => {
    assert.strictEqual(classifyCause('Fahrtausfälle wegen eines Streiks'), 'strike');
    assert.strictEqual(classifyCause('Aufgrund eines Warnstreiks entfällt die Fahrt'), 'strike');
  });

  it('classifies weather', () => {
    assert.strictEqual(classifyCause('aufgrund eines Unwetters'), 'weather');
    assert.strictEqual(classifyCause('wegen Sturm fällt die Fahrt aus'), 'weather');
  });

  it('classifies technical faults', () => {
    assert.strictEqual(classifyCause('Fahrzeugstörung auf der Strecke'), 'technical');
    assert.strictEqual(classifyCause('wegen einer Stellwerkstörung'), 'technical');
    assert.strictEqual(classifyCause('Oberleitungsschaden'), 'technical');
  });

  it('classifies construction', () => {
    assert.strictEqual(
      classifyCause('Fahrtausfälle wegen Bauarbeiten / Streckensperrung'),
      'construction',
    );
    assert.strictEqual(classifyCause('wegen einer Sperrung'), 'construction');
  });

  it('falls back to unknown when no cause keyword is present', () => {
    assert.strictEqual(classifyCause('Die Fahrt endet heute bereits am Hauptbahnhof'), 'unknown');
    assert.strictEqual(classifyCause(''), 'unknown');
  });
});

describe('classifyCause - priority ordering', () => {
  it('prefers strike over the generic betriebsbedingt (personnel)', () => {
    assert.strictEqual(
      classifyCause('betriebsbedingte Fahrtausfälle wegen eines Streiks'),
      'strike',
    );
  });

  it('prefers weather over betriebsbedingt', () => {
    assert.strictEqual(
      classifyCause('betriebsbedingter Ausfall aufgrund eines Unwetters'),
      'weather',
    );
  });

  it('prefers a specific technical cause over the generic sperrung (construction)', () => {
    assert.strictEqual(
      classifyCause('Fahrzeugstörung führt zur Sperrung der Strecke'),
      'technical',
    );
  });

  it('prefers personnel (betriebsbedingt) over construction (sperrung)', () => {
    assert.strictEqual(classifyCause('betriebsbedingter Ausfall, dazu eine Sperrung'), 'personnel');
  });
});
