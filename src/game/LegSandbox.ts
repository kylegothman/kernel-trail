// src/game/LegSandbox.ts
import type { Leg, LegEvaluationContext, LegOutcome, LegSetupContext,
              LegStage, StageContext, RandomEventDef, InteractionDef, RunState } from '@game/types';

export type LegFailure = {
  readonly phase: 'kernelConfig' | 'populate' | 'createStage' | 'update' | 'evaluate' | 'interaction';
  readonly error: unknown;
};

const NULL_STAGE: LegStage = {
  update() {}, anchor() { return null; }, dispose() {},
};

/**
 * Wraps every Leg entry point. A leg that throws degrades the leg, never the run.
 * Each phase has a defined fallback because "rethrow" is not an option here.
 */
export class LegSandbox {
  private failures: LegFailure[] = [];
  private stageDisabled = false;

  constructor(
    private readonly leg: Leg,
    private readonly onFailure: (f: LegFailure, leg: Leg) => void,
  ) {}

  get degraded(): boolean { return this.failures.length > 0; }
  get failureList(): readonly LegFailure[] { return this.failures; }

  kernelConfig(run: Parameters<Leg['kernelConfig']>[0]) {
    try {
      return this.leg.kernelConfig(run);
    } catch (error) {
      this.record({ phase: 'kernelConfig', error });
      // A leg that cannot describe its own kernel cannot run at all. The caller
      // treats a null config as "skip this leg", which is handled in §10.5.1.
      return null;
    }
  }

  populate(ctx: LegSetupContext): boolean {
    try { this.leg.populate(ctx); return true; }
    catch (error) { this.record({ phase: 'populate', error }); return false; }
  }

  createStage(ctx: StageContext): LegStage {
    try {
      const stage = this.leg.createStage(ctx);
      return this.wrapStage(stage);
    } catch (error) {
      this.record({ phase: 'createStage', error });
      return NULL_STAGE;
    }
  }

  private wrapStage(stage: LegStage): LegStage {
    return {
      update: (dt, alpha) => {
        if (this.stageDisabled) return;
        try { stage.update(dt, alpha); }
        catch (error) {
          // Disable after the first throw. A stage that throws once throws every
          // frame, and 60 error reports per second is its own outage.
          this.stageDisabled = true;
          this.record({ phase: 'update', error });
        }
      },
      anchor: (id) => { try { return stage.anchor(id); } catch { return null; } },
      dispose: () => { try { stage.dispose(); } catch { /* nothing useful to do */ } },
    };
  }

  evaluate(ctx: LegEvaluationContext): LegOutcome {
    try { return this.leg.evaluate(ctx); }
    catch (error) {
      this.record({ phase: 'evaluate', error });
      return this.neutralOutcome();
    }
  }

  /** Survive, change nothing, award nothing. The safest possible judgement. */
  private neutralOutcome(): LegOutcome {
    return {
      survived: true,
      objectivesMet: [],
      casualties: [],
      resourceDelta: {},
      codexUnlocked: [],
      debrief: {
        headline: 'Leg completed with reduced instrumentation',
        whatHappened:
          'This segment finished, but part of its scoring module failed and its ' +
          'result could not be judged.',
        whyItHappened:
          'A fault in the leg module, not in your decisions. Nothing has been ' +
          'taken from the convoy.',
        counterfactual: null,
        chapter: this.leg.chapters[0] ?? { chapter: 1, sections: [], title: '' },
      },
    };
  }

  predicate(def: RandomEventDef | InteractionDef, run: RunState): boolean {
    try {
      return 'onlyIf' in def ? def.onlyIf === null || def.onlyIf(run) : def.enabledWhen(run);
    } catch (error) {
      this.record({ phase: 'interaction', error });
      return false;
    }
  }

  private record(f: LegFailure): void {
    this.failures.push(f);
    this.onFailure(f, this.leg);
  }
}
