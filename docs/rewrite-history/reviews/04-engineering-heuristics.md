# Review 4: Engineering heuristics

Source: user-supplied general engineering review. Preserved verbatim below;
applicability to this rewrite is summarized in the rewrite-history index.

# Ten Engineering Heuristics for Systems That Tell the Truth Early

Yes—this is exactly the right move.

Nielsen’s contribution was not simply writing ten good interface principles. It was compressing recurring usability failures into a small set of **broad inspection lenses**. They are deliberately heuristics—rules of thumb rather than implementation guidelines—and Nielsen refined them against 249 observed usability problems to improve their explanatory coverage. ([Nielsen Norman Group][1])

We can attempt the same thing for software engineering:

> **A compact vocabulary for finding structural risk without prescribing how every system must be built.**

The engineering-scars material already gives us the raw corpus: ambiguous authority, invalid states, weak boundaries, unsafe retries, hidden overload, false abstractions, irreversible change, and lost causality.

The result should not be another clean-code checklist. It should help a reviewer look at unfamiliar code and ask ten unusually revealing questions.

---

## The operating rule: applicability before compliance

Before the ten heuristics, one rule governs how they are used:

> **A heuristic may be irrelevant.**

The reviewer should not ask:

> Did they use a state machine?

They should ask:

> Does history materially constrain which actions are legal here?

Only then does explicit state become relevant.

A heuristic identifies a class of risk. It does not prescribe a library, architecture, or pattern. Local evidence may legitimately defeat the general default.

---

## The compact set

|  # | Heuristic                                       | Core question                                                |
| -: | ----------------------------------------------- | ------------------------------------------------------------ |
|  1 | **One Fact, One Authority**                     | Who is entitled to decide this fact?                         |
|  2 | **Valid States, Explicit Transitions**          | What makes the system entitled to believe the new state?     |
|  3 | **Boundaries Reduce Uncertainty**               | Where does uncertain input become trustworthy?               |
|  4 | **Repetition Preserves Meaning**                | What happens when this logical operation occurs again?       |
|  5 | **Every Promise Is Bounded**                    | What limits the work the system has accepted?                |
|  6 | **Local Changes Stay Local**                    | Is the cost of change proportional to what changed?          |
|  7 | **Causality Remains Visible**                   | Can the system explain how it reached the present condition? |
|  8 | **Change Includes Recovery**                    | How do old and new realities coexist, and how do we recover? |
|  9 | **Abstract Shared Reasons, Not Similar Shapes** | Must these things change together for the same reason?       |
| 10 | **Complexity Must Be Earned**                   | What evidence makes this machinery necessary?                |

---

# 1. One Fact, One Authority

For every consequential fact, make explicit which component, rule, or protocol is authorized to decide it.

Copies may exist. Caches, projections, replicas, indexes, analytics tables, and UI models are often useful. But they should expose their relationship to authority:

* where the value came from;
* which version it represents;
* how old it may be;
* whether it may be stale;
* and whether it is allowed to initiate a change.

**Inspect for:** multiple components that can independently write what appears to be the same business fact; code that compares two sources and decides which one “wins”; projections presented as canonical state.

**Ask:**

> Who gets to decide this?

> If two sources disagree, is that a designed state or an ownership failure?

**Counterweight:** this does not mean one physical database. Authority may be partitioned, replicated, consensus-based, or defined by deterministic merge rules. The requirement is legibility, not centralization.

---

# 2. Valid States, Explicit Transitions

Represent meaningful states clearly, and perform important changes through operations that explain why the new state is legitimate.

A generic setter exposes mutation:

```text
setStatus("paid")
```

A domain transition carries meaning:

```text
Awaiting-payment order
        +
Captured payment
        ↓
Paid order
```

The inputs, actor, evidence, and prior state explain the change.

**Inspect for:** independent Booleans whose combinations were never designed; generic status setters; objects that can claim success without the evidence success requires; transition logic repeated across callers.

**Ask:**

> Which combinations should never exist?

> What event or evidence authorizes this transition?

> Can callers bypass the official transition?

**Counterweight:** do not force every calculation or UI mode into a formal state machine. Explicit state earns its place when history changes what may legitimately happen next.

---

# 3. Boundaries Reduce Uncertainty

A good boundary should leave the inside of the system more certain than the outside.

```text
Unknown representation
        ↓
Parse, authenticate, authorize, normalize
        ↓
Trusted domain value
```

Repeated Boolean validation often leaves the same uncertain object travelling downstream. Parsing constructs a representation that carries the established guarantee.

**Inspect for:** raw JSON passing through several layers; repeated null and shape checks; internal code revalidating facts already supposedly established; external failure treated as an impossible internal condition.

**Ask:**

> Where does this value become trusted?

> Does the boundary possess enough information to establish the guarantee completely?

> Which properties are stable, and which must be rechecked because they expire or change?

**Counterweight:** parse stable structure once, but revalidate volatile authority and freshness at use time. A syntactically valid credential may still have been revoked.

The broader balance is:

> **Prevent invalid internal states where you have control. Engineer and test defensive behavior where you do not.**

---

# 4. Repetition Preserves Meaning

A logical operation should retain its identity across retries, duplicate deliveries, process restarts, queues, and reconciliation.

A timeout says:

> The response did not arrive.

It does not say:

> The operation did not happen.

The system must define what repetition means:

* return the original result;
* do nothing;
* merge safely;
* compensate;
* or reconcile against an authoritative external effect.

**Inspect for:** retries around side effects without stable operation identity; “check then act” deduplication with a crash window; network attempts mistaken for business operations; unknown outcomes represented as ordinary failure.

**Ask:**

> Can this happen twice?

> How do two attempts identify themselves as one logical operation?

> What happens if the first attempt succeeded but its response was lost?

**Counterweight:** not every repeated action requires durable idempotency infrastructure. Pure reads and naturally idempotent operations may need only bounded retry behavior.

---

# 5. Every Promise Is Bounded

Accepting work creates an obligation.

Queues, retries, concurrent jobs, background operations, model calls, database queries, and fan-out all consume finite resources. Every such promise should have some combination of:

* capacity;
* concurrency limits;
* deadlines;
* useful-age limits;
* retry budgets;
* cancellation;
* prioritization;
* and overload behavior.

A queue may absorb a burst. It cannot repair a permanent mismatch between arrival and processing rates.

**Inspect for:** unbounded queues; unlimited retries; background work without deadlines; cancellation that stops waiting but not execution; work accepted after it can no longer produce useful results.

**Ask:**

> How much work may be accepted?

> When does this result stop being useful?

> What happens when capacity is exhausted?

> Does cancellation actually reach the underlying operation?

**Counterweight:** the limit should correspond to the real resource and service promise. An arbitrary queue length is not automatically meaningful backpressure.

---

# 6. Local Changes Stay Local

The computational and cognitive cost of a change should be proportional to its semantic scope.

One changed field should not invalidate an entire application.

One domain rule should not require understanding six unrelated callers.

One small feature should not require rebuilding a generalized platform.

This applies to:

* rendering;
* cache invalidation;
* synchronization;
* builds;
* tests;
* deployment;
* dependency graphs;
* and human reasoning.

**Inspect for:** broad invalidation; global mutable state; central objects touched by every feature; one local change awakening distant unrelated machinery; abstractions that force unrelated concepts to move together.

**Ask:**

> What else must wake up because this changed?

> Is that work semantically necessary or merely architecturally accidental?

> Can work be eliminated, narrowed, deferred, or reused rather than accelerated?

**Counterweight:** localizing every concern into isolated pieces can create excessive coordination and duplication. The goal is proportionality, not maximal fragmentation.

---

# 7. Causality Remains Visible

The system should be able to explain what it believes happened.

That requires more than accumulating log lines. Important identities should survive across boundaries:

* logical operation;
* attempt;
* triggering command;
* state version;
* transition;
* external effect;
* queue delivery;
* deployment version;
* and resulting state.

A useful explanation might be:

```text
One checkout
→ two request attempts
→ one captured payment
→ one lost response
→ one idempotent replay
→ one committed order transition
```

**Inspect for:** logs without operation identity; retries indistinguishable from separate work; projections with no source version; state changes that cannot be connected to commands; incidents that require guessing which events belong together.

**Ask:**

> Can an operator reconstruct one defensible causal story?

> Can the system distinguish what it knows, infers, and does not know?

> Does observability mirror the architecture’s real boundaries?

**Counterweight:** observability is not maximal data collection. Preserve enough causal evidence to answer important questions without leaking secrets or creating unbounded telemetry cost.

---

# 8. Change Includes Recovery

A change is not complete merely because the new version works.

Live systems contain overlapping realities:

* old and new application versions;
* old and new data representations;
* queued work created under old assumptions;
* long-lived clients;
* cached values;
* external integrations;
* and in-flight operations.

Safe change requires defined coexistence and recovery.

```text
Expand
  ↓
Migrate
  ↓
Verify
  ↓
Contract
```

**Inspect for:** destructive migrations deployed with new code; contracts that break old consumers immediately; feature flags that do not actually stop effects; rollback plans that restore code but not data; irreversible transformations without repair semantics.

**Ask:**

> Can old and new versions coexist?

> What happens to work created under the new version if we retreat?

> Is recovery rollback, forward repair, compensation, or reconciliation?

**Counterweight:** not every local change needs elaborate rollback infrastructure. Recovery effort should match irreversibility, blast radius, and the cost of being wrong.

---

# 9. Abstract Shared Reasons, Not Similar Shapes

An abstraction claims that several things are one concept.

That claim should be based on a shared reason for change, not merely current textual similarity.

Two functions may look identical while representing rules owned by different domains. Coupling them can save lines while forcing future changes to understand unrelated contexts.

Conversely, two implementations that look different may encode one authoritative business rule and should not diverge.

**Inspect for:** abstractions with growing mode parameters; helper functions full of caller-specific branches; generic interfaces whose consumers have unrelated invariants; copied authoritative rules that can silently disagree.

**Ask:**

> Must these behaviors change together for the same reason?

> Is the duplication textual, or is business knowledge being duplicated?

> Does the abstraction reduce facts a maintainer must remember—or add them?

**Counterweight:** “prefer duplication” is not permission to fork one authoritative rule. The target is honest coupling.

---

# 10. Complexity Must Be Earned

Every new state, service, abstraction, queue, cache, framework, tool, and coordination mechanism begins charging maintenance cost immediately.

Before admission, it should answer:

> What real requirement, observed pressure, established domain lesson, or credible risk makes you necessary?

Begin by identifying the **load-bearing few**:

* the small number of user journeys carrying most value;
* the boundaries carrying most correctness risk;
* the assumptions supporting most downstream architecture;
* and the failure modes causing most operational pain.

Then test the uncertainty that could invalidate the most work.

A technical spike is the smallest real implementation capable of disproving a consequential claim.

**Inspect for:** broad infrastructure before a vertical path exists; speculative scale; frameworks chosen for hypothetical futures; spikes incapable of changing the decision; mechanisms whose original justification has disappeared.

**Ask:**

> Which assumption is carrying this architecture?

> What observation could falsify it?

> Could a smaller mechanism protect the same property?

> What current pressure still justifies this complexity?

**Counterweight:** evidence includes more than your own incidents. Domain history, regulation, credible threat models, and irreversible harm may justify structure before local failure occurs.

Complexity has two gates:

```text
Admission:
What makes you necessary?

Renewal:
What still makes you necessary?
```

---

# Why these ten belong together

Each heuristic attacks a different source of hidden reasoning burden:

| Hidden burden                       | Heuristic                          |
| ----------------------------------- | ---------------------------------- |
| Several competing truths            | One Fact, One Authority            |
| Contradictory or unexplained states | Valid States, Explicit Transitions |
| Uncertainty travelling too far      | Boundaries Reduce Uncertainty      |
| Ambiguous history of effects        | Repetition Preserves Meaning       |
| Invisible overcommitment            | Every Promise Is Bounded           |
| Excessive blast radius              | Local Changes Stay Local           |
| Lost cause-and-effect relationships | Causality Remains Visible          |
| Irreversible evolution              | Change Includes Recovery           |
| False conceptual coupling           | Abstract Shared Reasons            |
| Speculative machinery               | Complexity Must Be Earned          |

Together, they restate the original thesis:

> **Make the system tell the truth early.**

Tell the truth about:

* who owns a fact;
* which states exist;
* why a transition is valid;
* whether an operation may already have happened;
* whether capacity is exhausted;
* how far a local change reaches;
* what caused the present condition;
* how change can be survived;
* which concepts genuinely belong together;
* and what evidence justified the complexity.

---

# How to use them like Nielsen’s heuristics

## 1. Localize them with Skill Init

The ten heuristics remain public and stable.

Their **priority and applicability** are repository-specific.

A payment service might classify:

```text
Critical:
1. One Fact, One Authority
2. Valid States, Explicit Transitions
4. Repetition Preserves Meaning
7. Causality Remains Visible
8. Change Includes Recovery
```

A short-lived internal prototype might prioritize:

```text
Critical:
9. Abstract Shared Reasons, Not Similar Shapes
10. Complexity Must Be Earned

Conditional:
2. Valid States, Explicit Transitions

Low priority:
8. Change Includes Recovery
```

The human supplies purpose, maturity, risk tolerance, and unacceptable failure.

The model supplies repository evidence.

Together they localize the lenses without rewriting their meaning.

---

## 2. Audit after free execution

Let the acting model solve the problem using local judgment.

Then freeze:

* the objective;
* diff;
* trace;
* tests;
* measurements;
* changed dependencies;
* migrations;
* and completion claims.

A fresh reviewer evaluates only materially applicable heuristics.

Return no more than three significant findings.

For each:

```yaml
heuristic: Repetition Preserves Meaning
applicable: true
evidence: retry added around payment-provider call
consequence: lost response may create duplicate charge
severity: serious
confidence: high
question: >
  What identifies repeated attempts as one logical payment?
```

The reviewer should ask a question before prescribing a mechanism.

---

## 3. Let the executor rebut

For each finding, the executor may:

* accept and repair;
* dispute applicability;
* justify the deviation;
* or request an experiment.

A justified deviation should fit into one paragraph and include:

* the decisive local fact;
* the trade-off;
* concrete evidence;
* exact scope;
* and what future condition would invalidate it.

Long explanations are not automatically wrong. But they are signals that the exception may contain hidden coupling, uncertain facts, or an architectural decision deserving human review.

---

## 4. Resolve disagreement through evidence

Allow one audit, one rebuttal, and one reconsideration.

Then:

```text
Factual disagreement
    → targeted test or spike

High-consequence judgment
    → human review

Low-risk local choice
    → executor proceeds with recorded exception

Hard invariant violation
    → block mechanically
```

Repeated model argument without new evidence is rhetoric, not verification.

---

## 5. Do not collapse the result into one score

Avoid:

```text
Engineering quality: 84/100
```

An implementation may have excellent ownership, unsafe retry semantics, appropriate simplicity, and weak recoverability.

Preserve the shape:

```yaml
authority: upheld
state: not_applicable
boundaries: upheld
repetition: serious_concern
capacity: upheld
locality: unclear
causality: concern
recovery: upheld
abstraction: upheld
earned_complexity: upheld
```

Profiles guide engineering judgment better than grades.

---

# The set itself must earn its place

This is still a **v0.1 heuristic set**, not scripture.

Nielsen did not stop when ten principles sounded elegant. He refined his set against a corpus of 249 usability problems to improve explanatory power. ([Nielsen Norman Group][1])

We should do the equivalent:

1. Collect postmortems, production bugs, problematic pull requests, failed migrations, and valid exceptions.
2. Have several experienced reviewers independently classify each problem.
3. Measure which heuristics explain serious failures.
4. Find heuristics that overlap too much.
5. Identify important failures none of them explain.
6. Measure false positives and valid rebuttals.
7. Refine wording and applicability conditions.
8. Re-run the corpus before promoting a new version.

The useful tests are:

* **Coverage:** Does the set explain most consequential engineering failures?
* **Discrimination:** Do different heuristics reveal meaningfully different problems?
* **Agreement:** Do experienced reviewers apply them similarly?
* **Actionability:** Does a finding lead to a better question or test?
* **Restraint:** Can the framework correctly conclude “not applicable”?
* **Locality:** Can Skill Init adapt priority without distorting the principle?

A heuristic set that cannot survive its own evaluation would be a particularly ironic failure of **Complexity Must Be Earned**.

---

# Poster version

> **1. One Fact, One Authority**
> Make decision authority explicit; treat copies as projections.
>
> **2. Valid States, Explicit Transitions**
> Represent meaningful states and carry justification into every important change.
>
> **3. Boundaries Reduce Uncertainty**
> Convert untrusted input into trusted internal guarantees.
>
> **4. Repetition Preserves Meaning**
> Give logical operations identity and define what retries and duplicates mean.
>
> **5. Every Promise Is Bounded**
> Limit accepted work by capacity, time, usefulness, and authority.
>
> **6. Local Changes Stay Local**
> Keep computational and cognitive cost proportional to semantic scope.
>
> **7. Causality Remains Visible**
> Preserve enough identity and evidence to explain what happened.
>
> **8. Change Includes Recovery**
> Design coexistence, compatibility, and recovery before deployment.
>
> **9. Abstract Shared Reasons, Not Similar Shapes**
> Couple concepts only when they must evolve together.
>
> **10. Complexity Must Be Earned**
> Test the load-bearing assumptions, choose the smallest sufficient mechanism, and remove it when its pressure disappears.

## Source assessment

| Source                                                                           |               Credibility | Role                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nielsen, “Enhancing the Explanatory Power of Usability Heuristics,” CHI 1994** |                **9.5/10** | Peer-reviewed foundation for deriving a compact heuristic set from a corpus of observed problems rather than intuition alone. ([ACM Digital Library][2])                                                                         |
| **Nielsen Norman Group, current heuristic summary**                              |                **8.5/10** | Authoritative practical account describing heuristics as broad rules of thumb and documenting their original refinement against 249 usability problems; not itself an independent modern validation. ([Nielsen Norman Group][1]) |
| **Uploaded Engineering Scars synthesis**                                         | **8.5/10 as a synthesis** | Supplies the recurring engineering failure patterns consolidated into the proposed ten heuristics; evidentiary strength ultimately comes from its cited primary systems literature.                                              |

[1]: https://www.nngroup.com/articles/ten-usability-heuristics/ "10 Usability Heuristics for User Interface Design - NN/G"
[2]: https://dl.acm.org/doi/10.1145/191666.191729?utm_source=chatgpt.com "Enhancing the explanatory power of usability heuristics"
