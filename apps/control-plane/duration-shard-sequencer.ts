import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import durations from "./test-durations.json";

// Mean CI module times (including collection/preparation) from the CI timing
// artifacts; refresh as CONTRIBUTING.md#check-shards
// describes. CI native fixtures are partitioned by provider/topology.
const measured: Record<string, number> = durations;
const times = Object.values(measured).sort((a, b) => a - b);
const unknownDuration = times[Math.floor(times.length / 2)];

export class DurationShardSequencer extends BaseSequencer {
  private path(file: TestSpecification) {
    return relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");
  }

  private duration(file: TestSpecification) {
    // New files join the partition automatically; never silently drop a test.
    return measured[this.path(file)] ?? unknownDuration;
  }

  async sort(files: TestSpecification[]) {
    // Start the longest files first so a late heavy file cannot strand a worker.
    return [...files].sort((a, b) => this.duration(b) - this.duration(a)
      || this.path(a).localeCompare(this.path(b), "en"));
  }

  async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!;
    const shards = Array.from({ length: count }, () => ({ files: [] as TestSpecification[], duration: 0 }));
    for (const file of await this.sort(files)) {
      // Longest-processing-time greedy partition, independent of discovery order
      // and of Vitest's runner-local result cache. Ties favor the lower shard.
      const shard = shards.reduce((best, next) => next.duration < best.duration ? next : best);
      shard.files.push(file);
      shard.duration += this.duration(file);
    }
    return shards[index - 1].files;
  }
}
