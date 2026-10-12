"""Small fixture tests; never install or build the workspace."""

import importlib.util
from pathlib import Path
import tempfile
import os
import re
import shlex
import subprocess
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("ci_policy", Path(__file__).with_name("check-ci-policy.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
# This suite tests the generic policy; guard rules a branch model names carry their own tests.
policy.GUARD_RULES = None
scope_spec = importlib.util.spec_from_file_location("ci_scope", Path(__file__).with_name("ci-scope.py"))
scope = importlib.util.module_from_spec(scope_spec)
scope_spec.loader.exec_module(scope)
ROOT = Path(__file__).resolve().parents[1]


CHECKOUT_SHA = "actions/checkout@" + "a" * 40
SCOPE_STEP = ("        with:\n          fetch-depth: 2 # the PR merge commit and both parents\n"
              "      - name: Area scope (PRs skip untouched inputs; see tools/ci-scope.py)\n"
              "        id: scope\n        run: python3 tools/ci-scope.py '.github/workflows/{name}' 'x/**'\n")
# A synthetic branch model that uses every gate; the policy is tested under it and under the default.
SAMPLE = policy.validated({"push": ["main", "staging/**"], "automation_prefix": "bot/", "integration_prefix": "staging/"})
MODELS = {"default": policy.DEFAULT_MODEL, "sample": SAMPLE}
# A synthetic repository id for deploy guards.
DEPLOY_ID = "123456"


def scratch_git_env():
    """Scratch repositories must not inherit GIT_DIR/GIT_WORK_TREE (a caller may run this suite with them set)."""
    return mock.patch.dict(os.environ, {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}, clear=True)


def if_line(gate, indent="    "):
    return f"{indent}if: {gate}\n" if gate else ""


def fixture_job(name, job, gate, canon):
    steps = "    steps:\n      - uses: " + CHECKOUT_SHA + "\n"
    if gate == "check":
        steps = "    steps:\n" + canon["check_step"] + "        run: true\n"
    if job in policy.SCOPED_JOBS[name]:
        # The fixture checkout carries the real pinned SHA so the scope rule sees it.
        steps = ("    steps:\n" + policy.CHECKOUT + SCOPE_STEP.format(name=name)
                 + "      - uses: " + CHECKOUT_SHA + "\n        if: " + policy.SCOPE_CONDITION + "\n")
    return f"  {job}:\n" + if_line(canon["gates"][gate]) + steps


def fixture_jobs(name, canon):
    if name == "ci.yml":
        return (fixture_job(name, "npm-pack", "needed", canon) + fixture_job(name, "spec-lint", "needed", canon)
                + fixture_job(name, "check", "check", canon).replace("    steps:", "    needs: [npm-pack, spec-lint]\n    steps:", 1)
                + fixture_job(name, "report", "full", canon))
    return "".join(fixture_job(name, job, "full", canon) for job in sorted(policy.SCOPED_JOBS[name]))


UPSTREAM = "octocove/octocove"


def evaluate(expression, event, ref="", head_ref="", base_ref="", head_repo=UPSTREAM, repository=UPSTREAM, repository_id="1"):
    """Evaluate a canonical gate (the operator subset it uses) for one synthetic event context.

    `head_repo` is the PR head's repository (`github.event.pull_request.head.repo.full_name`);
    the workflow runs in UPSTREAM (`github.repository`). An unknown context key raises. No
    gate (None) always runs.
    """
    if expression is None:
        return True
    context = {"github.event_name": event, "github.ref": ref, "github.head_ref": head_ref, "github.base_ref": base_ref,
               "github.repository": repository, "github.repository_owner": repository.split("/")[0],
               "github.repository_id": repository_id,
               "github.event.pull_request.head.repo.full_name": head_repo if event == "pull_request" else ""}
    python = expression.removeprefix("${{ ").removesuffix(" }}")
    python = re.sub(r"\bgithub(?:\.\w+)+", lambda m: repr(context[m[0]]), python)
    python = python.replace("startsWith(", "starts_with(").replace("always()", "True")
    python = python.replace("||", " or ").replace("&&", " and ").replace("!=", "<>").replace("!", " not ").replace("<>", "!=")
    return eval(python, {"__builtins__": {}}, {"starts_with": lambda value, prefix: value.startswith(prefix), "True": True})


def check_mutations(valid, canon):
    """Ways a ci.yml could stop `check` from reporting, or weaken its requirement step."""
    head, step_gate = "  check:\n    if: always()\n", canon["check_step_gate"]
    step = "        if: " + step_gate + "\n"
    job_ifs = [
        "    if: " + step_gate + "\n",  # the step gate's shape on the job: check skipped where needs are gated off
        "    if: ${{ always() }}\n",
        "    if: success()\n",
        "    if: '!cancelled()'\n",
        "    if: always() && github.event_name == 'push'\n",
        "    if: always() && github.base_ref == 'main'\n",
        "",
        "    if: always()\n    if: false\n",
    ]
    mutations = [valid.replace(head, "  check:\n" + job_if, 1) for job_if in job_ifs] + [
        valid.replace(step, "", 1),
        valid.replace(step, "        if: github.event_name == 'push'\n", 1),
        valid.replace(step, "        if: ${{ success() }}\n", 1),
        valid.replace(step, "        if: ${{ always() && github.event_name == 'push' }}\n", 1),
        valid.replace(head, head + "    continue-on-error: true\n    if: false\n", 1),
        valid.replace(canon["check_step"], "      - run: echo noop\n" + canon["check_step"], 1),
        valid.replace(canon["check_step"], canon["check_step"].replace("Require", "Report"), 1),
    ]
    if canon["automation"]:
        mutations += [
            valid.replace(step, "        if: ${{ " + canon["automation"] + " }}\n", 1),
            valid.replace(step_gate, step_gate.replace("== 'main'", "!= 'main'"), 1),
            valid.replace(step_gate, step_gate.replace("startsWith(github.head_ref, '", "startsWith(github.head_ref, 'x"), 1),
        ]
    return mutations


def trigger_mutations(valid, model):
    """Ways a required workflow's trigger block could leave the model's push set or filter pull requests."""
    branches = "    branches: [" + canonical_branches(model) + "]\n"
    mutations = [
        valid.replace("  push:\n", "  push:\n    paths: ['tools/**']\n"),
        valid.replace("  pull_request:\n", ""),
        valid.replace("  pull_request:\n", "  pull_request:\n    branches: [main]\n"),
        valid.replace("  pull_request:\n", "  pull_request:\n    paths-ignore: ['docs/**']\n"),
        valid.replace(branches, ""),
        valid.replace(branches, branches.replace("[main", "[master", 1)),
        valid.replace(branches, branches.replace("[main", "['main/**'", 1)),
        valid.replace(branches, branches.replace("]", ", 'preserve/**', 'evidence/**', 'docs/**']")),
        valid.replace(branches, branches.replace("]", ", '**']")),
    ]
    for pattern in model["push"][1:]:
        mutations += [valid.replace(f"'{pattern}'", "'other/**'"), valid.replace(f", '{pattern}'", "")]
    return mutations


def canonical_branches(model):
    return ", ".join(p if p == "main" else f"'{p}'" for p in model["push"])


class PolicyTests(unittest.TestCase):
    def test_private_and_dynamic_secret_contexts_fail(self):
        for expression in (
            "secrets.CLOUDFLARE_API_TOKEN", "secrets['PRIVATE']",
            "secrets[matrix.key]", "toJSON(secrets)",
            "secrets.GITHUB_TOKEN_OTHER", "secrets.GITHUB_TOKEN || secrets.PRIVATE",
        ):
            with self.subTest(expression=expression):
                self.assertTrue(policy.violations("env: ${{ " + expression + " }}"))

    def test_builtin_token_is_allowed(self):
        for expression in ("secrets.GITHUB_TOKEN", "secrets['GITHUB_TOKEN']", 'secrets["GITHUB_TOKEN"]'):
            self.assertEqual(policy.violations("env: ${{ " + expression + " }}"), [])

    def test_mutable_actions_fail(self):
        for action in ("actions/checkout@v4", "actions/checkout@main", "actions/checkout@1234"):
            self.assertTrue(policy.violations("  - uses: " + action))
        self.assertEqual(policy.violations("  - uses: 'actions/checkout@" + "a" * 40 + "' # v4"), [])
        self.assertEqual(policy.violations("  - uses: ./local-action"), [])

    def test_every_required_workflow_enforces_trigger_and_concurrency_policy(self):
        for label, model in MODELS.items():
            canon = policy.canonical(model)
            other = MODELS["sample" if label == "default" else "default"]
            with self.subTest(model=label), tempfile.TemporaryDirectory() as directory:
                self.check_model(Path(directory), model, canon, other)

    def check_model(self, root, model, canon, other):
        workflows = root / ".github/workflows"
        workflows.mkdir(parents=True)
        cancel = "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n"
        sources = {}
        for name in policy.REQUIRED_WORKFLOWS:
            sources[name] = (
                "on:\n" + canon["trigger"]
                + f"concurrency:\n  group: {Path(name).stem}-${{{{ github.ref }}}}\n"
                + cancel + "permissions:\n  contents: read\njobs:\n" + fixture_jobs(name, canon)
            )
            (workflows / name).write_text(sources[name])
        self.assertEqual(policy.check(root, model), [])
        # A tree canonical for one model fails under the other.
        self.assertTrue(policy.check(root, other))
        for name, valid in sources.items():
            invalid_sources = trigger_mutations(valid, model) + [
                valid.replace("a" * 40, "v4"),
                valid + "env: ${{ secrets.PRIVATE }}\n",
                valid.replace("${{ github.ref }}", "${{ github.sha }}"),
                valid.replace(f"{Path(name).stem}-${{{{ github.ref }}}}", "shared-${{ github.ref }}"),
                valid.replace(cancel, ""),
                valid.replace(cancel, "  cancel-in-progress: true\n"),
                valid.replace(cancel, "  cancel-in-progress: false\n"),
                valid.replace("github.event_name == 'pull_request' }}", "github.event_name == 'push' }}"),
                valid.replace("github.event_name == 'pull_request' }}", "github.event_name != 'push' }}"),
                valid.replace("concurrency:\n", "disabled-concurrency:\n"),
                # An ungated job (default model) or a second condition (gated model) on the first job.
                re.sub(r"^(  [\w-]+:\n)", r"\1    if: false\n", valid, count=1, flags=re.MULTILINE),
            ]
            for gate in canon["gates"].values():
                if gate and gate in valid and gate != canon["gates"]["check"]:
                    invalid_sources += [
                        valid.replace("    if: " + gate + "\n", "", 1),
                        valid.replace("    if: " + gate + "\n", "    if: always()\n", 1),
                        valid.replace("    if: " + gate + "\n", "    if: " + gate + "\n    if: true\n", 1),
                        valid.replace("    if: " + gate + "\n", "    if: " + gate + "\n      || true\n", 1),
                    ]
                    for old, new in (("startsWith(github.head_ref, '", "startsWith(github.head_ref, 'x"),
                                     ("== 'main'", "!= 'main'"), (policy.UPSTREAM_HEAD + " || ", ""),
                                     ("refs/heads/main'", "refs/heads/'")):
                        if old in gate:
                            invalid_sources.append(valid.replace(gate, gate.replace(old, new, 1), 1))
            if name == "ci.yml":
                invalid_sources += check_mutations(valid, canon)
            invalid_sources += [
                valid.replace("        if: " + policy.SCOPE_CONDITION + "\n", "", 1),
                valid.replace("fetch-depth: 2", "fetch-depth: 1", 1),
                valid.replace("tools/ci-scope.py '.github/workflows/", "tools/ci-scope.py '", 1),
                valid.replace(SCOPE_STEP.format(name=name), "", 1),
            ]
            for invalid in invalid_sources:
                with self.subTest(workflow=name, source=invalid):
                    self.assertNotEqual(invalid, valid)
                    (workflows / name).write_text(invalid)
                    self.assertTrue(any(e.startswith(name + ":") for e in policy.check(root, model)))
            (workflows / name).write_text(valid)

    def test_branch_model_is_validated_and_defaults_to_main(self):
        self.assertEqual(policy.load_model(Path("/nonexistent/ci-branch-model.json")), policy.DEFAULT_MODEL)
        default = policy.canonical(policy.DEFAULT_MODEL)
        self.assertEqual(default["trigger"], "  push:\n    branches: [main]\n  pull_request:\n")
        self.assertEqual((default["gates"]["needed"], default["gates"]["full"]), (None, None))
        self.assertEqual(default["check_step_gate"], "${{ always() }}")
        for bad in ({"push": []}, {"push": ["dev", "main"]}, {"push": ["main", "main"]}, {"push": ["main", "x/*"]},
                    {"push": ["main", "x/**", "x/**"]}, {"push": ["main", "a b/**"]},
                    {"automation_prefix": "bot"}, {"automation_prefix": ""}, {"integration_prefix": "staging/"},
                    {"push": ["main", "staging/**"], "automation_prefix": "staging/", "integration_prefix": "staging/"}):
            with self.subTest(model=bad), self.assertRaises(ValueError):
                policy.validated({**policy.DEFAULT_MODEL, **bad})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.json"
            path.write_text('{"why": "fixture", "push": ["main", "staging/**"], "automation_prefix": "bot/", '
                            '"integration_prefix": "staging/"}\n')
            self.assertEqual(policy.load_model(path), SAMPLE)

    def test_retarget_rewrites_only_triggers_and_gates_and_round_trips(self):
        models = [policy.MODEL, SAMPLE, policy.DEFAULT_MODEL]
        for name in policy.REQUIRED_WORKFLOWS:
            source = (ROOT / ".github/workflows" / name).read_text()
            with self.subTest(workflow=name):
                for target in models:
                    rendered = policy.retarget(name, source, policy.MODEL, target)
                    self.assertEqual(policy.workflow_violations(name, rendered, target), [])
                    self.assertEqual(policy.retarget(name, rendered, target, policy.MODEL), source)
                    # Nothing but `if:` lines and the push branches differ.
                    strip = lambda text: [line for line in text.splitlines()
                                          if not re.match(r"\s+(?:if|branches):", line)]
                    self.assertEqual(strip(rendered), strip(source))
                default = policy.retarget(name, source, policy.MODEL, policy.DEFAULT_MODEL)
                self.assertNotIn("head_ref", default)
                self.assertIn("    branches: [main]\n", default)
        # A source that is not canonical for its model is refused, never half-rewritten.
        source = (ROOT / ".github/workflows/ci.yml").read_text()
        with self.assertRaises(ValueError):
            policy.retarget("ci.yml", source.replace("concurrency:\n", "disabled:\n"), policy.MODEL, SAMPLE)
        with self.assertRaises(ValueError):
            policy.retarget("ci.yml", source, SAMPLE if policy.MODEL != SAMPLE else policy.DEFAULT_MODEL, SAMPLE)

    def test_retarget_workflows_rewrites_the_tree_in_place(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github/workflows").mkdir(parents=True)
            for name in policy.REQUIRED_WORKFLOWS:
                (root / ".github/workflows" / name).write_text((ROOT / ".github/workflows" / name).read_text())
            changed = policy.retarget_workflows(root, policy.MODEL, SAMPLE)
            self.assertEqual(policy.check(root, SAMPLE), [])
            self.assertEqual(policy.retarget_workflows(root, SAMPLE, SAMPLE), [])
            self.assertEqual(sorted(changed), sorted(f".github/workflows/{n}" for n in policy.REQUIRED_WORKFLOWS)
                             if policy.MODEL != SAMPLE else [])

    def test_check_aggregate_rejects_unsuccessful_repo_hygiene(self):
        source = (Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml").read_text()
        aggregate = source.split("  check:\n", 1)[1].split("  spec-lint:\n", 1)[0]
        self.assertIn("    if: " + policy.GATES["check"] + "\n", aggregate)
        self.assertRegex(aggregate, r"needs: \[.*repo-hygiene.*\]")
        self.assertIn("${{ needs.repo-hygiene.result }}", aggregate)
        script = aggregate.split("        run: |\n", 1)[1]
        script = "\n".join(line[10:] for line in script.splitlines() if line.strip())
        env = {**os.environ, **{key: "success" for key in re.findall(r"^          (\w+_RESULT):", aggregate, re.MULTILINE)}}
        for result in ("success", "failure", "skipped", "cancelled", ""):
            with self.subTest(result=result):
                completed = subprocess.run(["bash", "-e", "-c", script], env={**env, "HYGIENE_RESULT": result})
                self.assertEqual(completed.returncode == 0, result == "success")
        hygiene = policy.jobs(source)["repo-hygiene"]
        self.assertEqual(re.findall(r"^\s*if:.*\n", hygiene, re.MULTILINE), [if_line(policy.GATES["needed"])] if policy.GATES["needed"] else [])
        self.assertNotIn("--output", hygiene)
        self.assertNotIn("upload-artifact", hygiene)

    def test_check_aggregate_rejects_every_unsuccessful_dependency(self):
        # An area-skipped prerequisite reports success; a job-skipped one must turn check red.
        source = (Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml").read_text()
        aggregate = policy.jobs(source)["check"]
        needs = re.search(r"needs: \[(.*)\]", aggregate)[1].split(", ")
        variables = re.findall(r"^          (\w+_RESULT): \$\{\{ needs\.([\w-]+)\.result \}\}$", aggregate, re.MULTILINE)
        self.assertEqual(sorted(job for _, job in variables), sorted(needs))
        script = aggregate.split("        run: |\n", 1)[1]
        script = "\n".join(line[10:] for line in script.splitlines() if line.strip())
        for variable, _ in variables:
            for result in ("success", "failure", "skipped", "cancelled", ""):
                with self.subTest(variable=variable, result=result):
                    env = {**os.environ, **{name: "success" for name, _ in variables}, variable: result}
                    completed = subprocess.run(["bash", "-e", "-c", script], env=env)
                    self.assertEqual(completed.returncode == 0, result == "success")

    def test_check_reports_on_every_event(self):
        # This policy pins `if: always()` on check.
        source = (Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml").read_text()
        for label, model in {"repository": policy.MODEL, **MODELS}.items():
            canon = policy.canonical(model)
            rendered = policy.retarget("ci.yml", source, policy.MODEL, model)
            aggregate = policy.jobs(rendered)["check"]
            with self.subTest(model=label):
                self.assertEqual(canon["gates"]["check"], "always()")
                self.assertEqual(re.findall(r"^    if: (.*)$", aggregate, re.MULTILINE), ["always()"])
                self.assertEqual(re.findall(r"^        if: (.*)$", aggregate, re.MULTILINE), [canon["check_step_gate"]])
                self.assertEqual(len(re.findall(r"^      - ", aggregate, re.MULTILINE)), 1)
                self.assertIn("\n    steps:\n" + canon["check_step"], aggregate)
            for mutated in check_mutations(rendered, canon):
                with self.subTest(model=label, source=mutated):
                    self.assertNotEqual(mutated, rendered)
                    self.assertTrue(policy.job_violations("ci.yml", mutated, model))

    def test_gates_per_event(self):
        # (event, ref, head_ref, base_ref) -> runs? for needed and check's
        # requirement step, full, walkthrough; the check job itself always runs.
        gates = policy.canonical(SAMPLE)["gates"]
        step_gate = policy.canonical(SAMPLE)["check_step_gate"]
        cases = [
            (("push", "refs/heads/main", "", ""), True, True),
            (("push", "refs/heads/staging/x", "", ""), True, True),
            (("pull_request", "refs/pull/1/merge", "bot/a", "main"), True, True),
            (("pull_request", "refs/pull/1/merge", "bot/a", "staging/x"), False, False),
            (("pull_request", "refs/pull/1/merge", "bot/a", "release"), False, False),
            (("pull_request", "refs/pull/1/merge", "staging/x", "main"), True, False),
            (("pull_request", "refs/pull/1/merge", "fork-feature", "main"), True, True),
            (("pull_request", "refs/pull/1/merge", "staging/x", "staging/y"), True, True),
        ]
        default = policy.canonical(policy.DEFAULT_MODEL)
        for args, gate_check, full in cases:
            with self.subTest(event=args):
                self.assertEqual(evaluate(gates["needed"], *args), gate_check)
                self.assertTrue(evaluate(gates["check"], *args))
                self.assertEqual(evaluate(step_gate, *args), gate_check)
                self.assertEqual(evaluate(gates["full"], *args), full)
                self.assertEqual(evaluate(gates["walkthrough"], *args), full)
                # The default model gates nothing: every PR and every main push runs every job.
                for gate in (default["gates"]["needed"], default["gates"]["full"], default["check_step_gate"]):
                    self.assertTrue(evaluate(gate, *args))
                self.assertEqual(evaluate(default["gates"]["walkthrough"], *args), args[1] != "refs/heads/staging/x")
        self.assertFalse(evaluate(gates["walkthrough"], "workflow_dispatch", "refs/heads/bot/a"))
        self.assertFalse(evaluate(default["gates"]["walkthrough"], "workflow_dispatch", "refs/heads/bot/a"))

    def test_fork_heads_never_get_the_automation_or_integration_exemption(self):
        # Identical branch names, upstream head vs fork head. The fork row runs everything,
        # so a fork `staging/*` into main cannot skip the spec lint, the tarball gate or
        # any other job while `check` passes.
        canon = policy.canonical(SAMPLE)
        gated = (canon["gates"]["needed"], canon["check_step_gate"], canon["gates"]["full"], canon["gates"]["walkthrough"])
        fork = "someone/octocove"
        for head_ref, base_ref in (("staging/x", "main"), ("staging/integration-b", "main"), ("bot/a", "staging/x"), ("bot/a", "release")):
            args = ("pull_request", "refs/pull/1/merge", head_ref, base_ref)
            with self.subTest(head_ref=head_ref, base_ref=base_ref):
                upstream = [evaluate(gate, *args) for gate in gated]
                self.assertFalse(all(upstream))  # the upstream head is exempt from something
                for gate in gated:
                    self.assertTrue(evaluate(gate, *args, head_repo=fork), gate)
                self.assertTrue(evaluate(canon["gates"]["check"], *args, head_repo=fork))
        # Every gated job in every required workflow carries the upstream term through the canonical text.
        for name in policy.REQUIRED_WORKFLOWS:
            source = policy.retarget(name, (ROOT / ".github/workflows" / name).read_text(), policy.MODEL, SAMPLE)
            for job, block in policy.jobs(source).items():
                for condition in re.findall(r"^\s+if: (.*)$", block, re.MULTILINE):
                    if "head_ref" in condition:
                        with self.subTest(workflow=name, job=job):
                            self.assertEqual(condition.count("startsWith(github.head_ref"), condition.count(policy.UPSTREAM_HEAD))

    def test_gate_without_the_upstream_term_fails_policy(self):
        source = policy.retarget("ci.yml", (ROOT / ".github/workflows/ci.yml").read_text(), policy.MODEL, SAMPLE)
        weakened = source.replace(policy.UPSTREAM_HEAD + " || !startsWith(github.head_ref, 'bot/')", "!startsWith(github.head_ref, 'bot/')", 1)
        self.assertNotEqual(weakened, source)
        self.assertTrue(policy.job_violations("ci.yml", weakened, SAMPLE))
        widened = source.replace("full_name != github.repository", "full_name == github.repository", 1)
        self.assertTrue(policy.job_violations("ci.yml", widened, SAMPLE))

    def test_repository_jobs_carry_their_gates(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(policy.check(root), [])
        ci = policy.jobs((root / ".github/workflows/ci.yml").read_text())
        # Every job check needs shares the automation gate of check's requirement step, so
        # an automation PR into an integration branch skips that step instead of failing it
        # on skipped needs; everywhere else the step sees every need run.
        needs = re.search(r"needs: \[(.*)\]", ci["check"])[1].split(", ")
        for job in needs:
            self.assertEqual(re.findall(r"^    if: .*\n", ci[job], re.MULTILINE), [if_line(policy.GATES["needed"])] if policy.GATES["needed"] else [])
        if policy.AUTOMATION_GATE:
            self.assertIn(policy.AUTOMATION_GATE, policy.CHECK_STEP_GATE)
        for job in set(ci) - set(needs) - {"check"}:
            self.assertEqual(re.findall(r"^    if: .*\n", ci[job], re.MULTILINE), [if_line(policy.GATES["full"])] if policy.GATES["full"] else [])


    def test_secret_and_environment_jobs_carry_their_repository_guard(self):
        deploy, public = policy.deploy_guard(DEPLOY_ID), policy.PUBLIC_GUARD

        def workflow(condition, body="    environment: production\n", head=""):
            condition = "" if condition is None else f"    if: {condition}\n"
            return f"name: x\n{head}jobs:\n  deploy:\n{condition}    runs-on: ubuntu-latest\n{body}"

        secret = "    env:\n      T: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n"
        for name, guard, other in (("deploy.yml", deploy, public), ("npm-publish.yml", public, deploy)):
            with self.subTest(workflow=name):
                for condition in (guard, guard + " && github.ref == 'refs/heads/main'",
                                  guard + " && github.event_name == 'push' && (startsWith(github.ref, 'a') || startsWith(github.ref, 'b'))",
                                  guard + " && github.ref == 'refs/tags/a||b'"):
                    self.assertEqual(policy.guard_violations(name, workflow(condition)), [], condition)
                    self.assertEqual(policy.guard_violations(name, workflow(condition, secret)), [], condition)
                for condition in (None, "github.ref == 'refs/heads/main'", other, other + " && github.ref == 'refs/heads/main'",
                                  "github.ref == 'refs/heads/main' && " + guard, "${{ " + guard + " }}",
                                  guard + " && github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'",
                                  guard + " || always()", guard + "x", "always() || " + guard,
                                  "github.repository_id == '0' && github.ref == 'refs/heads/main'"):
                    for body in ("    environment: production\n", secret, "    secrets: inherit\n",
                                 "    environment:\n      name: npm\n"):
                        self.assertTrue(policy.guard_violations(name, workflow(condition, body)), (condition, body))
                # YAML folds every continuation into the condition, so a guard on the first line is not enough:
                # a continued plain scalar, a folded block, a literal block and a quoted multi-line string.
                for continued in (f"{guard} && true\n      || true", f"{guard}\n\n      || true", f"{guard} && true\n        # note\n      || true",
                                  f">-\n      {guard} && true\n      || true", f">\n      {guard}", f"|\n      {guard}",
                                  f"'{guard} && true\n      || true'", f'"{guard} && true\n      || true"', f"\n      {guard}"):
                    for body in ("    environment: production\n", secret):
                        errors = policy.guard_violations(name, workflow(continued, body))
                        self.assertTrue(any("one unquoted line" in error for error in errors), (continued, errors))
                # Two job-level conditions are rejected even when one is the guard.
                self.assertTrue(policy.guard_violations(name, workflow(guard, "    if: always()\n" + secret)))
                # Jobs without secrets or an environment, and the built-in token, need no guard.
                self.assertEqual(policy.guard_violations(name, workflow(None, "    steps: []\n")), [])
                self.assertEqual(policy.guard_violations(name, workflow(None, "    env:\n      T: ${{ secrets.GITHUB_TOKEN }}\n")), [])
                # A workflow-level secret escapes every job guard.
                self.assertTrue(policy.guard_violations(name, workflow(guard, head="env:\n  T: ${{ secrets.NPM_TOKEN }}\n")))
                self.assertEqual(policy.guard_violations(name, workflow(guard, head="# reads deployment secrets\n")), [])

    def test_repository_guards_run_each_workflow_only_where_it_belongs(self):
        # A deploy job, if present, runs only in the repository whose id it pins: a same-org copy has the
        # same owner but another id, and a fork has neither. npm publishing runs only in the public repository.
        public, fork = policy.PUBLIC_REPOSITORY, "someone/octocove"
        runs, pinned = {}, {}
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            if path.name in policy.REQUIRED_WORKFLOWS:
                continue
            ref = "refs/tags/cli-v1.0.0" if path.name in policy.PUBLIC_ONLY_WORKFLOWS else "refs/heads/main"
            for job, block in policy.jobs(path.read_text()).items():
                if policy.uses_secrets(block) or policy.names_environment(block):
                    condition = re.findall(r"^    if: (.*)$", block, re.MULTILINE)[0]
                    guard = policy.DEPLOY_GUARD.match(condition)
                    pinned[path.name + ":" + job] = guard[1] if guard else DEPLOY_ID
                    repositories = {public: "2", "acme/app": pinned[path.name + ":" + job], "acme/copy": "3", fork: "4"}
                    runs[path.name + ":" + job] = {
                        repository: evaluate(condition, "push", ref, repository=repository, repository_id=repository_id)
                        for repository, repository_id in repositories.items()}
        self.assertEqual(runs.pop("npm-publish.yml:publish"), {name: name == public for name in (public, "acme/app", "acme/copy", fork)})
        for name, result in runs.items():
            self.assertEqual(result, {repository: repository == "acme/app" for repository in result}, name)
        # The deploy guard names no repository or owner, only an id.
        self.assertNotRegex(policy.deploy_guard(DEPLOY_ID), r"github\.repository(?:_owner)? ")
        self.assertTrue(policy.DEPLOY_GUARD.fullmatch(policy.deploy_guard(DEPLOY_ID)))

    def test_deploy_guard_pins_an_id_and_the_main_ref(self):
        environment = "    runs-on: ubuntu-latest\n    environment: production\n"
        guarded = lambda condition: f"name: x\njobs:\n  deploy:\n    if: {condition}\n" + environment
        self.assertEqual(policy.guard_violations("deploy.yml", guarded(policy.deploy_guard(DEPLOY_ID))), [])
        for condition in ("github.repository_id == '" + DEPLOY_ID + "'",
                          "github.repository_id == '" + DEPLOY_ID + "' && github.ref != 'refs/heads/main'",
                          "github.ref == 'refs/heads/main' && github.repository_id == '" + DEPLOY_ID + "'",
                          "github.repository_id == 'x' && github.ref == 'refs/heads/main'"):
            self.assertTrue(policy.guard_violations("deploy.yml", guarded(condition)), condition)
        # Any pinned id passes the generic rule.
        self.assertEqual(policy.guard_violations("deploy.yml", guarded(policy.deploy_guard("42"))), [])

    def test_guard_rules_load_only_from_a_named_module_beside_the_model(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "model.json"
            self.assertIsNone(policy.load_guard_rules(model))
            model.write_text('{"push": ["main"]}')
            self.assertIsNone(policy.load_guard_rules(model))
            (Path(directory) / "rules.py").write_text(
                "def guard_violations(job, repository_id):\n    return [] if repository_id == '7' else [job]\n")
            model.write_text('{"guard_rules": "rules.py"}')
            rules = policy.load_guard_rules(model)
            self.assertEqual((rules.guard_violations("deploy", "7"), rules.guard_violations("deploy", "8")), ([], ["deploy"]))
            model.write_text('{"guard_rules": "missing.py"}')
            self.assertIsNone(policy.load_guard_rules(model))
            for value in ('"../rules.py"', '"rules"', '7'):
                model.write_text('{"guard_rules": ' + value + '}')
                with self.assertRaises(ValueError):
                    policy.load_guard_rules(model)
            source = "name: x\njobs:\n  deploy:\n    if: {}\n    runs-on: ubuntu-latest\n    environment: production\n"
            with mock.patch.object(policy, "GUARD_RULES", rules):
                self.assertEqual(policy.guard_violations("deploy.yml", source.format(policy.deploy_guard("7"))), [])
                self.assertEqual(policy.guard_violations("deploy.yml", source.format(policy.deploy_guard("8"))), ["deploy"])

    def test_owner_based_deploy_guard_is_rejected(self):
        environment = "    runs-on: ubuntu-latest\n    environment: production\n"
        for condition in ("github.repository_owner == 'yolo-labs-hq' && github.repository != 'yolo-labs-hq/octocove'",
                          "github.repository_id == " + DEPLOY_ID + " && github.ref == 'refs/heads/main'"):
            source = f"name: x\njobs:\n  deploy:\n    if: {condition}\n" + environment
            self.assertTrue(policy.guard_violations("deploy.yml", source), condition)

    def test_unparsed_jobs_fail_closed(self):
        secret = "${{ secrets.CLOUDFLARE_API_TOKEN }}"
        unparsed = {
            "4-space indentation": "jobs:\n    deploy:\n      environment: production\n      runs-on: x\n",
            "flow-style jobs": "jobs: {deploy: {environment: production, runs-on: x}}\n",
            "flow-style job": "jobs:\n  deploy: {environment: production, runs-on: x}\n",
            "quoted job key": "jobs:\n  'deploy':\n    environment: production\n",
            "quoted job-level key": "jobs:\n  deploy:\n    'environment': production\n",
            "6-space job keys": "jobs:\n  deploy:\n      environment: production\n",
            "merge key": "jobs:\n  deploy:\n    <<: *deploy\n",
            "tab indentation": "jobs:\n\tdeploy:\n\t\tenvironment: production\n",
            "trailing top-level key": "jobs:\n  deploy:\n    runs-on: x\nenv:\n  T: " + secret + "\n",
            "quoted jobs key": '"jobs":\n  deploy:\n    environment: production\n',
            "duplicate job": "jobs:\n  a:\n    runs-on: x\n  a:\n    environment: production\n",
            "empty jobs": "jobs:\n",
        }
        for label, body in unparsed.items():
            with self.subTest(shape=label):
                source = "name: x\non: push\n" + body
                with self.assertRaises(policy.UnparsedJobs):
                    policy.jobs(source)
                self.assertTrue(policy.guard_violations("deploy.yml", source))
                self.assertTrue(policy.job_violations("ci.yml", source))
        # The canonical shape still parses, comments and blank lines included.
        self.assertEqual(list(policy.jobs("jobs:\n  # note\n  a: # comment\n    runs-on: x\n\n    steps:\n      - run: y\n  b:\n    runs-on: x\n")),
                         ["a", "b"])

    def test_required_workflows_never_name_an_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github/workflows").mkdir(parents=True)
            for name in policy.REQUIRED_WORKFLOWS:
                (root / ".github/workflows" / name).write_text((ROOT / ".github/workflows" / name).read_text())
            self.assertEqual(policy.check(root), [])
            path = root / ".github/workflows/ci.yml"
            valid = path.read_text()
            needle = "    runs-on: ubuntu-latest\n"
            self.assertIn(needle, valid)
            for environment in ("    environment: production\n", "    environment:\n      name: production\n",
                                "    environment: {name: production}\n"):
                with self.subTest(environment=environment):
                    path.write_text(valid.replace(needle, needle + environment, 1))
                    self.assertIn("ci.yml: required workflows must not name an environment", policy.check(root))
            # A required workflow with a guard is still refused: required workflows are not guarded, they are environment-free.
            path.write_text(valid.replace(needle, needle + "    environment: production\n", 1)
                            .replace("    if: ", "    if: " + policy.deploy_guard(DEPLOY_ID) + " && ", 1))
            self.assertIn("ci.yml: required workflows must not name an environment", policy.check(root))

    def test_area_scope_globs(self):
        cases = [
            ("apps/example/**", "apps/example/src/a.ts", True),
            ("apps/example/**", "apps/examples/a.ts", False),
            ("apps/example/**", "apps/example", False),
            ("**/package.json", "package.json", True),
            ("**/package.json", "apps/example/package.json", True),
            ("**/package.json", "apps/example/package.json.bak", False),
            ("tools/example/licenses*", "tools/example/licenses.py", True),
            ("tools/example/licenses*", "tools/example/sub/licenses.py", False),
            ("apps/*/public/licenses/**", "apps/example/public/licenses/MIT.txt", True),
            (".nvmrc", "x.nvmrc", False),
            ("apps/example/**", "apps/example/new\nline.ts", True),
            ("apps/*/x", "apps/a\nb/x", True),
        ]
        for glob, path, expected in cases:
            with self.subTest(glob=glob, path=path):
                self.assertEqual(bool(scope.pattern(glob).match(path)), expected)

    def test_area_scope_fails_toward_running(self):
        globs = ["apps/example/**"]
        self.assertEqual(scope.decide("push", None, globs)[0], True)
        self.assertEqual(scope.decide("push", ["docs/a.md"], globs)[0], True)
        self.assertEqual(scope.decide("workflow_dispatch", ["docs/a.md"], globs)[0], True)
        self.assertEqual(scope.decide("pull_request", None, globs)[0], True)
        self.assertEqual(scope.decide("pull_request", [], globs)[0], True)
        self.assertEqual(scope.decide("pull_request", ["tools/ci-scope.py"], globs)[0], True)
        self.assertEqual(scope.decide("pull_request", ["docs/a.md", "apps/example/x"], globs)[0], True)
        self.assertEqual(scope.decide("pull_request", ["docs/a.md"], globs)[0], False)

    def test_scoped_jobs_cover_the_inputs_they_read(self):
        # Globs come from the real workflows, so dropping one from a job fails here.
        def globs(name, job):
            block = policy.jobs((ROOT / ".github/workflows" / name).read_text())[job]
            line = next(line for line in block.splitlines() if "python3 tools/ci-scope.py " in line)
            return shlex.split(line.split("python3 tools/ci-scope.py ", 1)[1])

        cases = [
            # The CLI bundles client and shared sources.
            ("ci.yml", "npm-pack", "packages/cli/src/cli.ts", True),
            ("ci.yml", "npm-pack", "packages/client/README.md", True),
            ("ci.yml", "npm-pack", "packages/shared/src/merge.mjs", True),
            ("ci.yml", "npm-pack", "NOTICE", True),
            # Every frozen-lockfile install checks each workspace manifest.
            ("ci.yml", "npm-pack", "pnpm-lock.yaml", True),
            ("ci.yml", "npm-pack", "packages/helper/src/index.ts", False),
            ("ci.yml", "npm-pack", "tools/conformance/run.mjs", False),
            ("ci.yml", "spec-lint", "spec/openapi.yaml", True),
            ("ci.yml", "spec-lint", "docs/API.md", False),
        ]
        for name, job, path, expected in cases:
            with self.subTest(job=job, path=path):
                self.assertEqual(scope.decide("pull_request", [path], globs(name, job))[0], expected)

    def test_area_scope_reads_the_pr_merge_commit(self):
        script = Path(__file__).with_name("ci-scope.py")
        with tempfile.TemporaryDirectory() as directory, scratch_git_env():
            def git(*args):
                subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                               cwd=directory, check=True, capture_output=True)

            def run(event, *globs):
                output = Path(directory) / "output"
                output.write_text("")
                env = {**os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_OUTPUT": str(output)}
                subprocess.run([sys.executable, "-B", str(script), *globs], cwd=directory, env=env,
                               check=True, capture_output=True)
                return output.read_text()

            git("init", "-q", "-b", "main")
            (Path(directory) / "base.txt").write_text("base\n")
            git("add", "."); git("commit", "-q", "-m", "base")
            git("checkout", "-q", "-b", "topic/x")
            (Path(directory) / "docs").mkdir()
            (Path(directory) / "docs/a.md").write_text("topic\n")
            git("add", "."); git("commit", "-q", "-m", "topic")
            git("checkout", "-q", "main")
            # Base movement after the topic branch forked must not count as the PR's change.
            (Path(directory) / "apps").mkdir()
            (Path(directory) / "apps/site.txt").write_text("main\n")
            git("add", "."); git("commit", "-q", "-m", "main moves")
            self.assertEqual(run("pull_request", "apps/**"), "run=true\n")  # not a merge commit
            git("merge", "-q", "--no-ff", "-m", "merge", "topic/x")
            self.assertEqual(run("pull_request", "apps/**"), "run=false\n")
            self.assertEqual(run("pull_request", "docs/**"), "run=true\n")
            self.assertEqual(run("push", "apps/**"), "run=true\n")

    def test_area_scope_reads_unquoted_names(self):
        # Default core.quotePath would hand decide() '"apps/example/caf\\303\\251.ts"', which
        # matches no glob and skips the job although its input changed.
        script = Path(__file__).with_name("ci-scope.py")
        with tempfile.TemporaryDirectory() as directory, scratch_git_env():
            def git(*args):
                subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                               cwd=directory, check=True, capture_output=True)

            def merged(name):
                git("checkout", "-q", "-b", "topic/" + str(len(names)), "main")
                path = Path(directory) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("topic\n")
                git("add", "-A"); git("commit", "-q", "-m", "topic")
                git("checkout", "-q", "--detach", "main")
                git("merge", "-q", "--no-ff", "-m", "merge", "topic/" + str(len(names)))
                names.append(name)
                output = Path(directory) / ".git" / "output"
                output.write_text("")
                env = {**os.environ, "GITHUB_EVENT_NAME": "pull_request", "GITHUB_OUTPUT": str(output)}
                subprocess.run([sys.executable, "-B", str(script), "apps/example/**"], cwd=directory, env=env,
                               check=True, capture_output=True)
                return output.read_text()

            names = []
            git("init", "-q", "-b", "main")
            (Path(directory) / "base.txt").write_text("base\n")
            git("add", "."); git("commit", "-q", "-m", "base")
            for name in ("apps/example/caf\u00e9.ts", "apps/example/new\nline.ts", "apps/example/tab\there.ts"):
                with self.subTest(name=name):
                    self.assertEqual(merged(name), "run=true\n")
            self.assertEqual(merged("docs/unrelated.md"), "run=false\n")
            # A changed_files() result is handed to decide() unquoted.
            git("checkout", "-q", "--detach", "topic/0")
            git("merge", "-q", "--no-ff", "-m", "merge", "topic/1")
            cwd = os.getcwd()
            try:
                os.chdir(directory)
                self.assertEqual(scope.changed_files(), ["apps/example/new\nline.ts"])
            finally:
                os.chdir(cwd)

    def test_area_scope_fails_closed_on_unparseable_diff(self):
        globs = ["apps/example/**"]
        self.assertEqual(scope.parse_names(b""), [])
        self.assertEqual(scope.parse_names("apps/example/caf\u00e9.ts\0docs/a\tb\0".encode()),
                         ["apps/example/caf\u00e9.ts", "docs/a\tb"])
        self.assertEqual(scope.parse_names(b"apps/example/\xff\0"), ["apps/example/\udcff"])
        for raw in (b"docs/a.md", b"docs/a.md\n", b"docs/a.md\0\0", b"\0"):
            with self.subTest(raw=raw):
                self.assertIsNone(scope.parse_names(raw))
                self.assertEqual(scope.decide("pull_request", scope.parse_names(raw), globs)[0], True)

    def test_required_set_is_the_ci_workflow(self):
        self.assertEqual(policy.REQUIRED_WORKFLOWS, ("ci.yml",))

    def test_missing_required_workflows_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(len(policy.check(Path(directory))), len(policy.REQUIRED_WORKFLOWS))


if __name__ == "__main__":
    unittest.main()
