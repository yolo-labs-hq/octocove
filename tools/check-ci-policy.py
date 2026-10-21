#!/usr/bin/env python3
"""Text-level fail-closed policy for the repository workflows (no deps; unparsed shapes are errors)."""

import importlib.util
import json
from pathlib import Path
import re
import sys


REQUIRED_WORKFLOWS = ("ci.yml",)
TOKEN_REFERENCE = re.compile(
    r"\bsecrets\s*(?:\.\s*GITHUB_TOKEN\b|\[\s*(['\"])GITHUB_TOKEN\1\s*\])"
)
ACTION = re.compile(r"^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$", re.MULTILINE)

# Branch model. Required workflows run on every pull_request and on pushes to the
# branches in `push` (main first). The default model is just that: no job carries a
# gate, every PR runs every job, and check's requirement step runs always(). A
# repository may add ci-branch-model.json beside this file to name two optional
# same-repository head prefixes:
# - automation_prefix: a PR from such a head into any base but main skips every job
#   except check, whose requirement step is skipped too (check reports success).
#   Those PRs are merged into an integration branch without waiting for checks; the
#   integration branch's own push runs the full set.
# - integration_prefix: a PR from such a head into main runs only check and its
#   needs, because the push of the same head already ran the rest. Its branches
#   must also be in `push`.
# Both exemptions apply only to a head branch in this repository: a fork PR's head
# name is the fork author's choice, so a fork head with either prefix always runs
# every job. canonical() derives one spelling per gate class from the model; every
# job carries exactly its class's gate (or none where the class has no gate).
# `check` itself is exactly `if: always()` so the aggregate always reports. retarget() re-renders a canonical
# workflow for another model, such as the default model.
BRANCH_MODEL = Path(__file__).resolve().with_name("ci-branch-model.json")
DEFAULT_MODEL = {"push": ["main"], "automation_prefix": None, "integration_prefix": None}
PUSH_PATTERN = re.compile(r"[\w.-]+/(?:[\w.-]+/)*\*\*")
PREFIX = re.compile(r"[\w.-]+/(?:[\w.-]+/)*")
UPSTREAM_HEAD = "github.event.pull_request.head.repo.full_name != github.repository"


def load_model(path=BRANCH_MODEL):
    """The branch model in path, or DEFAULT_MODEL when there is none; malformed models raise ValueError."""
    if not path.is_file():
        return dict(DEFAULT_MODEL)
    return model_from(json.loads(path.read_text()))


def model_from(data):
    """A validated model from a parsed model file; absent keys take their default, other keys are notes."""
    return validated({key: data.get(key, DEFAULT_MODEL[key]) for key in DEFAULT_MODEL})


def validated(model):
    push = model["push"]
    if (not isinstance(push, list) or not push or push[0] != "main" or len(set(push)) != len(push)
            or not all(isinstance(p, str) and PUSH_PATTERN.fullmatch(p) for p in push[1:])):
        raise ValueError("branch model: push must be main followed by distinct `prefix/**` patterns")
    for key in ("automation_prefix", "integration_prefix"):
        if model[key] is not None and not (isinstance(model[key], str) and PREFIX.fullmatch(model[key])):
            raise ValueError(f"branch model: {key} must be null or a `name/` prefix")
    if model["integration_prefix"] is not None and model["integration_prefix"] + "**" not in push:
        raise ValueError("branch model: integration branches must receive push checks")
    if model["automation_prefix"] is not None and model["automation_prefix"] == model["integration_prefix"]:
        raise ValueError("branch model: automation and integration prefixes must differ")
    return model


def expression(*terms):
    terms = [term for term in terms if term]
    if not terms:
        return None
    if len(terms) == 1:
        return f"${{{{ {terms[0]} }}}}"
    return "${{ " + " && ".join(f"({term})" for term in terms) + " }}"


def canonical(model):
    """Canonical trigger block, gates and check step for a branch model."""
    automation = integration = None
    if model["automation_prefix"]:
        automation = ("github.event_name != 'pull_request' || " + UPSTREAM_HEAD
                      + f" || !startsWith(github.head_ref, '{model['automation_prefix']}') || github.base_ref == 'main'")
    if model["integration_prefix"]:
        integration = ("github.event_name != 'pull_request' || " + UPSTREAM_HEAD
                       + f" || !startsWith(github.head_ref, '{model['integration_prefix']}') || github.base_ref != 'main'")
    ref_guard = "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'" + "".join(
        f" || startsWith(github.ref, 'refs/heads/{pattern[:-2]}')" for pattern in model["push"][1:])
    branches = ", ".join(p if p == "main" else f"'{p}'" for p in model["push"])
    step_gate = f"${{{{ always() && ({automation}) }}}}" if automation else "${{ always() }}"
    return dict(
        automation=automation, integration=integration, ref_guard=ref_guard,
        trigger=f"  push:\n    branches: [{branches}]\n  pull_request:\n",
        gates={"needed": expression(automation), "check": "always()", "full": expression(automation, integration),
               "walkthrough": expression(ref_guard, automation, integration)},
        check_step_gate=step_gate,
        check_step="      - name: Require every check dependency to pass\n        if: " + step_gate + "\n",
    )


MODEL = load_model()
CANONICAL = canonical(MODEL)
AUTOMATION_GATE, INTEGRATION_GATE, REF_GUARD = CANONICAL["automation"], CANONICAL["integration"], CANONICAL["ref_guard"]
GATES, CHECK_STEP_GATE, CHECK_STEP = CANONICAL["gates"], CANONICAL["check_step_gate"], CANONICAL["check_step"]

# In-job area skips: exactly these jobs call tools/ci-scope.py, right after a
# depth-2 checkout, and every later step is conditional on its output.
SCOPED_JOBS = {
    "ci.yml": {"licenses", "npm-pack"},
}
CHECKOUT = "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n"
SCOPE_RUN = "        id: scope\n        run: python3 tools/ci-scope.py '.github/workflows/{name}' "
SCOPE_CONDITION = "steps.scope.outputs.run == 'true'"
# Repository guards. Every job outside the required set that reads a secret other
# than GITHUB_TOKEN or names an environment opens its `if:` with a guard: npm
# publishing runs only in PUBLIC_REPOSITORY (npm provenance must name the
# repository in package.json); any other such job is a deploy job: if present, it
# pins one repository by its numeric `github.repository_id` and guards the main ref.
# An owner test would admit any other repository of the organisation (a same-org
# copy); the id names exactly one repository and survives renames and transfers.
# Look it up with `gh api repos/<owner>/<repo> -q .id`. A repository can add
# stricter deploy-guard checks: its branch model file may name a module beside it
# (`guard_rules`), loaded when present, whose guard_violations(job, repository_id)
# then runs for every deploy guard; its errors join the policy's.
PUBLIC_REPOSITORY = "yolo-labs-hq/octocove"
PUBLIC_GUARD = "github.repository == '" + PUBLIC_REPOSITORY + "'"
MAIN_REF = "github.ref == 'refs/heads/main'"
REPOSITORY_ID = re.compile(r"[1-9][0-9]*")


def deploy_guard(repository_id):
    """The leading condition of a deploy job pinned to repository_id."""
    return f"github.repository_id == '{repository_id}' && {MAIN_REF}"


DEPLOY_GUARD = re.compile(r"github\.repository_id == '(" + REPOSITORY_ID.pattern + r")' && " + re.escape(MAIN_REF))


def load_guard_rules(path=BRANCH_MODEL):
    """The guard-rule module the branch model in path names, or None when there is no model, it names none
    or the named module is absent."""
    if not path.is_file():
        return None
    name = json.loads(path.read_text()).get("guard_rules")
    if name is None:
        return None
    if not (isinstance(name, str) and re.fullmatch(r"[\w.-]+\.py", name)):
        raise ValueError("branch model: guard_rules must name a module file beside the model")
    if not path.with_name(name).is_file():
        return None
    spec = importlib.util.spec_from_file_location("ci_guard_rules", path.with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUARD_RULES = load_guard_rules()
# Any `environment` key, block or flow style, quoted or not. Required workflows may
# not name one at all; elsewhere it makes a job repository-guarded.
ENVIRONMENT = re.compile(r"""(?:^|[\s{,])["']?environment["']?\s*:""", re.MULTILINE)
PUBLIC_ONLY_WORKFLOWS = ("npm-publish.yml",)


def violations(source):
    errors = []
    # Reject the whole remaining context, including bracket/dynamic indexing,
    # toJSON(secrets), job-level expressions and aliases in YAML anchors.
    if re.search(r"\bsecrets\b", TOKEN_REFERENCE.sub("", source), re.IGNORECASE):
        errors.append("secret context other than GITHUB_TOKEN")
    for match in ACTION.finditer(source):
        action = match.group(1).split(" #", 1)[0].strip().strip("'\"")
        if not action.startswith("./") and not re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", action):
            errors.append("external action must be pinned to a full commit SHA")
    return errors


def check(root, model=None):
    errors = []
    for name in REQUIRED_WORKFLOWS:
        path = root / ".github/workflows" / name
        if not path.is_file():
            errors.append(f"{name}: required workflow is missing")
            continue
        errors.extend(f"{name}: {error}" for error in workflow_violations(name, path.read_text(), model))
    for path in sorted((root / ".github/workflows").glob("*.y*ml")):
        if path.name not in REQUIRED_WORKFLOWS:
            errors.extend(f"{path.name}: {error}" for error in guard_violations(path.name, path.read_text()))
    return errors


def workflow_violations(name, source, model=None):
    """Policy errors of one required workflow under a branch model (default: the loaded one)."""
    model = MODEL if model is None else model
    errors = list(violations(source))
    if names_environment(source):
        errors.append("required workflows must not name an environment")
    # Canonical text blocks make this dependency-free guard fail closed.
    # PRs are unfiltered; only the model's push branches receive push checks.
    trigger = re.search(r"^on:\s*\n(.*?)(?=^\S|\Z)", source, re.MULTILINE | re.DOTALL)
    if not trigger or trigger[1] != canonical(model)["trigger"]:
        errors.append(f"push must allow only {', '.join(model['push'])}; pull_request must be unfiltered")
    concurrency = re.search(r"^concurrency:\s*\n(.*?)(?=^\S|\Z)", source, re.MULTILINE | re.DOTALL)
    # PR runs cancel superseded PR runs; pushes queue so every pushed head of a
    # push branch still reaches a completed run.
    expected_concurrency = (f"  group: {Path(name).stem}-${{{{ github.ref }}}}\n"
                            "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n")
    if not concurrency or concurrency[1] != expected_concurrency:
        errors.append("workflow-specific per-ref concurrency cancelling only pull_request runs is required")
    errors.extend(job_violations(name, source, model))
    return errors


def retarget(name, source, source_model, target_model):
    """Required workflow `name`, canonical under source_model, rendered for target_model.

    Only the trigger block, each job's gate line and check's step gate change; the
    source must pass the policy under source_model and the result under
    target_model, or ValueError is raised."""
    errors = workflow_violations(name, source, source_model)
    if errors:
        raise ValueError(f"{name} is not canonical for its branch model: " + "; ".join(errors))
    old, new = canonical(source_model), canonical(target_model)
    head, body = source.split("\njobs:\n", 1)
    head = head.replace("\non:\n" + old["trigger"], "\non:\n" + new["trigger"], 1)
    needs = re.search(r"^    needs: \[(.+)\]\n", jobs(source).get("check", ""), re.MULTILINE)
    needed = {item.strip() for item in needs[1].split(",")} if needs else set()
    lines, job = [], None
    for line in body.splitlines(keepends=True):
        header = JOB_HEADER.fullmatch(line)
        if header:
            job = header[1]
            gate_of = gate_class(name, job, needed)
            # An ungated job gains its gate as its first key, where gated jobs carry it.
            if not old["gates"][gate_of] and new["gates"][gate_of]:
                line += f"    if: {new['gates'][gate_of]}\n"
        elif job is not None and line == f"    if: {old['gates'][gate_class(name, job, needed)]}\n":
            gate = new["gates"][gate_class(name, job, needed)]
            line = f"    if: {gate}\n" if gate else ""
        elif job == "check" and line == f"        if: {old['check_step_gate']}\n":
            line = f"        if: {new['check_step_gate']}\n"
        lines.append(line)
    result = head + "\njobs:\n" + "".join(lines)
    errors = workflow_violations(name, result, target_model)
    if errors:
        raise ValueError(f"{name} does not retarget cleanly: " + "; ".join(errors))
    return result


def retarget_workflows(root, source_model, target_model):
    """Rewrite root's required workflows from source_model to target_model in place; the files changed."""
    changed = []
    for name in REQUIRED_WORKFLOWS:
        path = root / ".github/workflows" / name
        if path.is_file():
            text = path.read_text()
            result = retarget(name, text, source_model, target_model)
            if result != text:
                path.write_text(result)
                changed.append(f".github/workflows/{name}")
    return changed


def uses_secrets(text):
    return re.search(r"\bsecrets\b", TOKEN_REFERENCE.sub("", text), re.IGNORECASE) is not None


def names_environment(text):
    return ENVIRONMENT.search(uncommented(text)) is not None


def uncommented(text):
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def top_level_or(expression):
    """True if `||` occurs outside parentheses and string literals."""
    depth, quoted = 0, False
    for index, char in enumerate(expression):
        if char == "'":
            quoted = not quoted
        elif not quoted and char in "()":
            depth += 1 if char == "(" else -1
        elif not quoted and depth == 0 and expression.startswith("||", index):
            return True
    return False


def multiline_if(block):
    """True if a job-level `if:` is not one plain line: quoted, a `|`/`>` block scalar, empty with its value below, or
    followed by deeper-indented lines, which YAML folds into the condition (`if: guard && x` then `      || true`
    allows anything). The checks below read only the `if:` line, so such a condition is refused, not reconstructed."""
    lines = block.splitlines()
    for index, line in enumerate(lines):
        value = re.fullmatch(r"    if:(.*)", line)
        if not value:
            continue
        if not value[1].strip() or value[1].strip()[0] in "|>'\"":
            return True
        following = next((text for text in lines[index + 1:] if text.strip()), "")
        if len(following) - len(following.lstrip(" ")) > 4:
            return True
    return False


def guard_violations(name, source):
    """Secret- or environment-bearing jobs outside the required set carry their repository guard."""
    public = name in PUBLIC_ONLY_WORKFLOWS
    head = source.split("\njobs:\n", 1)[0]
    errors = []
    if uses_secrets(uncommented(head)) or names_environment(head):
        errors.append("secrets and environments may be named only inside a repository-guarded job")
    try:
        blocks = jobs(source)
    except UnparsedJobs as error:
        return errors + [str(error)]
    if not blocks:
        return errors + ["jobs section is missing"]
    for job, block in blocks.items():
        if not uses_secrets(block) and not names_environment(block):
            continue
        if multiline_if(block):
            errors.append(f"job {job} reads secrets or an environment, so its if: must be one unquoted line "
                          "(YAML folds quoted, block and continued scalars into the condition)")
            continue
        found = re.findall(r"^    if: (.*)$", block, re.MULTILINE)
        rest = None
        if len(found) == 1:
            guard = re.match(re.escape(PUBLIC_GUARD) if public else DEPLOY_GUARD.pattern, found[0])
            rest = found[0][guard.end():] if guard else None
            if guard and not public and GUARD_RULES is not None:
                errors.extend(GUARD_RULES.guard_violations(job, guard[1]))
        # `guard && a || b` would run on `b` anywhere; the rest must bind tighter than &&.
        if rest is None or (rest and (not rest.startswith(" && ") or top_level_or(rest))):
            expected = PUBLIC_GUARD if public else deploy_guard("<repository id>")
            errors.append(f"job {job} reads secrets or an environment, so its if: must start with "
                          f"`{expected}` followed by nothing or ` && ` and conditions without a top-level ||")
    return errors


class UnparsedJobs(ValueError):
    """A jobs: block in a shape this dependency-free parser does not recognise."""


JOB_HEADER = re.compile(r"  ([\w-]+):[ \t]*(?:#.*)?\n?")
JOB_KEY = re.compile(r"    [\w-]+:(?:[ \t].*)?\n?")


def jobs(source):
    """Map job id -> job block text (lines after the header), in file order.

    Fails closed: PyYAML is not in every image that runs this policy, so the hand
    parser accepts only the canonical shape (block-style `jobs:` as the last
    top-level key, 2-space job ids, 4-space job keys, no tabs, anchors, quoted or
    flow-style keys) and raises UnparsedJobs on anything else rather than reading
    a workflow it does not understand as having no jobs. {} only when there is
    no jobs key at all.
    """
    lines = source.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if re.match(r"""["']?jobs["']?[ \t]*:""", line)]
    if not starts and not re.search(r"""\bjobs["']?\s*:""", uncommented(source)):
        return {}
    if len(starts) != 1 or lines[starts[0]].rstrip("\n") != "jobs:":
        raise UnparsedJobs("jobs must be a single block-style mapping (`jobs:` alone on its line)")
    blocks, current = {}, None
    for line in lines[starts[0] + 1:]:
        text = line.rstrip("\n")
        if "\t" in text:
            raise UnparsedJobs("jobs section must not contain tabs")
        if not text.strip() or text.lstrip().startswith("#"):
            if current is not None:
                blocks[current] += line
            continue
        indent = len(text) - len(text.lstrip(" "))
        if indent == 0:
            raise UnparsedJobs("jobs must be the last top-level key")
        if indent == 2:
            header = JOB_HEADER.fullmatch(line)
            if not header:
                raise UnparsedJobs(f"unrecognised job header {text.strip()!r}: job ids are 2-space block keys")
            current = header[1]
            if current in blocks:
                raise UnparsedJobs(f"job {current} is defined twice")
            blocks[current] = ""
            continue
        if current is None or indent < 4 or (indent == 4 and not JOB_KEY.fullmatch(line)):
            raise UnparsedJobs(f"unrecognised line in jobs {text.strip()!r}: job keys are 4-space block keys")
        if not uncommented(blocks[current]).strip() and indent != 4:
            raise UnparsedJobs(f"job {current} must start with a 4-space key")
        blocks[current] += line
    if not blocks:
        raise UnparsedJobs("jobs section has no job this parser recognises")
    return blocks


def gate_class(name, job, needed):
    if name == "ci.yml" and job == "check":
        return "check"
    if name == "ci.yml" and job in needed:
        return "needed"
    return "full"


def job_violations(name, source, model=None):
    canon = canonical(MODEL if model is None else model)
    errors = []
    try:
        blocks = jobs(source)
    except UnparsedJobs as error:
        return [str(error)]
    if not blocks:
        return ["jobs section is missing"]
    needed = set()
    if name == "ci.yml":
        check = blocks.get("check", "")
        match = re.search(r"^    needs: \[(.+)\]\n", check, re.MULTILINE)
        if not match:
            errors.append("check job with a needs list is required")
        else:
            needed = {item.strip() for item in match[1].split(",")}
        steps = check.split("\n    steps:\n", 1)
        if (len(steps) != 2 or not steps[1].startswith(canon["check_step"])
                or len(re.findall(r"^      - ", steps[1], re.MULTILINE)) != 1
                or len(re.findall(r"^\s*if:", check, re.MULTILINE)) != 2):
            errors.append("check must have exactly one step, the requirement step under the canonical step gate")
    for job, block in blocks.items():
        expected = canon["gates"][gate_class(name, job, needed)]
        found = re.findall(r"^    if: (.*)$", block, re.MULTILINE)
        if found != ([expected] if expected else []) or multiline_if(block):
            errors.append(f"job {job} must carry exactly the canonical {gate_class(name, job, needed)} gate"
                          + ("" if expected else " (none)"))
        scoped = "tools/ci-scope.py" in block
        if scoped != (job in SCOPED_JOBS.get(name, set())):
            errors.append(f"job {job} must {'' if not scoped else 'not '}run the area scope step")
        if scoped:
            errors.extend(f"job {job}: {error}" for error in scope_violations(name, block))
    for job in SCOPED_JOBS.get(name, set()) - set(blocks):
        errors.append(f"scoped job {job} is missing")
    return errors


def scope_violations(name, block):
    head = (CHECKOUT + "        with:\n          fetch-depth: 2 # the PR merge commit and both parents\n"
            "      - name: Area scope (PRs skip untouched inputs; see tools/ci-scope.py)\n"
            + SCOPE_RUN.format(name=name))
    if block.count(head) != 1 or block.count("tools/ci-scope.py '") != 1:
        return ["area scope must follow a depth-2 checkout and include its own workflow"]
    before, after = block.split(head, 1)
    if CHECKOUT in before or re.search(r"^      - ", before, re.MULTILINE):
        return ["area scope must be the step right after the only checkout"]
    steps = re.split(r"^(?=      - )", after.split("\n", 1)[1], flags=re.MULTILINE)
    for step in filter(None, steps):
        condition = re.findall(r"^        if: (.*)$", step, re.MULTILINE)
        if len(condition) != 1 or condition[0] not in (SCOPE_CONDITION, "always() && " + SCOPE_CONDITION):
            return ["every step after the area scope must be conditional on its output"]
    return []


if __name__ == "__main__":
    errors = check(Path(__file__).resolve().parents[1])
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        sys.exit(1)
    print(f"Required workflows pass secret, action-pin, trigger (push: {', '.join(MODEL['push'])}), per-ref concurrency,"
          " job-gate and area-scope policy; no required workflow names an environment; secret- and environment-bearing jobs carry their repository guard.")
