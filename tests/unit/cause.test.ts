/**
 * Tests for cancellation cause classification.
 * Uses real German strings (with umlauts) to exercise the umlaut-aware normalization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyCause, classifyCauseWithEvidence } from '../../src/cause.js';

describe('classifyCause - categories', () => {
  it('classifies a *named* staffing/sickness cause as personnel', () => {
    assert.strictEqual(classifyCause('Fahrtausfälle wegen Personalmangel'), 'personnel');
    assert.strictEqual(classifyCause('krankheitsbedingter Ausfall'), 'personnel');
    assert.strictEqual(classifyCause('Engpass beim Fahrpersonal'), 'personnel');
  });

  it('classifies a bare betriebsbedingt as the (unspecified) operational residual', () => {
    // No specifics beyond the euphemism — must NOT be promoted to personnel.
    assert.strictEqual(classifyCause('betriebsbedingte Fahrtausfälle'), 'operational');
    assert.strictEqual(classifyCause('betriebsbedingter Ausfall'), 'operational');
  });

  it('classifies a named operational traffic condition as operational', () => {
    assert.strictEqual(
      classifyCause('Dichte Zugfolge. Auf der Linie S4 kommt es zu Fahrtausfällen.'),
      'operational',
    );
  });

  it('classifies a generic Betriebsstörung as an (unspecified) disruption', () => {
    assert.strictEqual(
      classifyCause('Betriebsstörung. Auf der Linie S4 kommt es zu einzelnen Fahrtausfällen.'),
      'disruption',
    );
  });

  it('classifies strike', () => {
    assert.strictEqual(classifyCause('Fahrtausfälle wegen eines Streiks'), 'strike');
    assert.strictEqual(classifyCause('Aufgrund eines Warnstreiks entfällt die Fahrt'), 'strike');
  });

  it('classifies weather', () => {
    assert.strictEqual(classifyCause('aufgrund eines Unwetters'), 'weather');
    assert.strictEqual(classifyCause('wegen Sturm fällt die Fahrt aus'), 'weather');
  });

  it('classifies a named emergency-services intervention', () => {
    assert.strictEqual(classifyCause('Feuerwehreinsatz im Bereich Forbach Bahnhof'), 'emergency');
  });

  it('classifies a vehicle (rolling-stock) fault', () => {
    assert.strictEqual(classifyCause('Fahrzeugstörung auf der Strecke'), 'vehicle');
    assert.strictEqual(classifyCause('wegen eines Fahrzeugschadens'), 'vehicle');
    assert.strictEqual(classifyCause('aufgrund eines Fahrzeugdefekts'), 'vehicle');
  });

  it('classifies vehicle keywords robustly across German declension', () => {
    // Compound-noun keywords must match every declined form, not just the nominative —
    // otherwise the same fault buckets differently depending on grammar (the fixed bug).
    for (const s of ['ein Fahrzeugdefekt', 'eines Fahrzeugdefekts', 'die Fahrzeugstörung']) {
      assert.strictEqual(classifyCause(s), 'vehicle', s);
    }
    // The adjective+noun phrasing "defektes Fahrzeug" is deliberately NOT a vehicle keyword
    // (it cannot match declined forms robustly); it lands consistently in `technical` instead.
    assert.strictEqual(classifyCause('ein defektes Fahrzeug'), 'technical');
    assert.strictEqual(classifyCause('wegen eines defekten Fahrzeugs'), 'technical');
  });

  it('classifies an infrastructure fault', () => {
    assert.strictEqual(classifyCause('wegen einer Stellwerkstörung'), 'infrastructure');
    assert.strictEqual(classifyCause('Stellwerkausfall im Bereich Rastatt'), 'infrastructure');
    assert.strictEqual(classifyCause('Stellwerksstörung bei Bretten'), 'infrastructure');
    assert.strictEqual(classifyCause('Oberleitungsschaden bei Durlach'), 'infrastructure');
    assert.strictEqual(classifyCause('eine Weichenstörung'), 'infrastructure');
  });

  it('classifies a generically-named technical fault', () => {
    assert.strictEqual(classifyCause('wegen einer technischen Störung'), 'technical');
    assert.strictEqual(classifyCause('aufgrund eines technischen Defekts'), 'technical');
  });

  it('classifies construction', () => {
    assert.strictEqual(
      classifyCause('Fahrtausfälle wegen Bauarbeiten / Streckensperrung'),
      'construction',
    );
    assert.strictEqual(classifyCause('wegen einer Sperrung'), 'construction');
    assert.strictEqual(classifyCause('Instandhaltungsarbeiten an der Oberleitung'), 'construction');
    assert.strictEqual(
      classifyCause('Instandhaltungsarbeiten (Gleiserneuerung) der AVG'),
      'construction',
    );
    assert.strictEqual(
      classifyCause('Grund: DB InfraGO - kurzfristige Weichenarbeiten im Bf Rastatt'),
      'construction',
    );
    assert.strictEqual(classifyCause('die AVG sperrt die Enztalbahn'), 'construction');
  });

  it('falls back to unknown when no cause keyword is present', () => {
    assert.strictEqual(classifyCause('Die Fahrt endet heute bereits am Hauptbahnhof'), 'unknown');
    assert.strictEqual(classifyCause(''), 'unknown');
  });
});

describe('classifyCause - priority ordering', () => {
  it('prefers strike over the generic betriebsbedingt (operational)', () => {
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

  it('prefers a named emergency over generic closure wording', () => {
    assert.strictEqual(
      classifyCause('Streckensperrung wegen eines Feuerwehreinsatzes'),
      'emergency',
    );
  });

  it('prefers a named vehicle fault over the generic sperrung (construction)', () => {
    assert.strictEqual(classifyCause('Fahrzeugstörung führt zur Sperrung der Strecke'), 'vehicle');
  });

  it('prefers a specific fault over the generic technical bucket', () => {
    // "Fahrzeugstörung" (vehicle) sits above the generic "technische Störung" (technical).
    assert.strictEqual(classifyCause('technische Störung: eine Fahrzeugstörung'), 'vehicle');
  });

  it('prefers named personnel over the bare betriebsbedingt euphemism', () => {
    assert.strictEqual(
      classifyCause('betriebsbedingter Ausfall wegen Personalmangel'),
      'personnel',
    );
  });

  it('prefers operational (betriebsbedingt) over construction (sperrung)', () => {
    assert.strictEqual(
      classifyCause('betriebsbedingter Ausfall, dazu eine Sperrung'),
      'operational',
    );
  });

  it('prefers a named technical fault over a generic Betriebsstörung', () => {
    assert.strictEqual(classifyCause('Betriebsstörung wegen einer Fahrzeugstörung'), 'vehicle');
  });

  it('prefers named personnel over a bare Betriebsstörung', () => {
    assert.strictEqual(classifyCause('Betriebsstörung wegen Personalmangel'), 'personnel');
  });
});

describe('classifyCauseWithEvidence - matched keyword', () => {
  it('reports the normalized keyword that drove the classification', () => {
    assert.deepStrictEqual(classifyCauseWithEvidence('Engpass beim Fahrpersonal'), {
      cause: 'personnel',
      causeKeyword: 'fahrpersonal',
    });
    assert.deepStrictEqual(classifyCauseWithEvidence('betriebsbedingter Ausfall'), {
      cause: 'operational',
      causeKeyword: 'betriebsbedingt',
    });
    assert.deepStrictEqual(classifyCauseWithEvidence('wegen einer Stellwerkstörung'), {
      cause: 'infrastructure',
      causeKeyword: 'stellwerkstoerung',
    });
  });

  it('reports the most specific matching keyword within the winning category', () => {
    assert.deepStrictEqual(classifyCauseWithEvidence('Witterungsbedingte Störung'), {
      cause: 'weather',
      causeKeyword: 'witterungsbedingt',
    });
    assert.deepStrictEqual(classifyCauseWithEvidence('Gleisbauarbeiten im Bahnhof'), {
      cause: 'construction',
      causeKeyword: 'gleisbauarbeiten',
    });
  });

  it('reports a null keyword for unknown', () => {
    assert.deepStrictEqual(classifyCauseWithEvidence('nichts passendes hier'), {
      cause: 'unknown',
      causeKeyword: null,
    });
  });
});
