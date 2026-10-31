---
id: C-example
type: mapping
project: example
source_domain: evolutionary biology (social behaviour in animals)
target_domain: microbiology (Pseudomonas aeruginosa)
status: survived
authored_by: example
reviewed_by: [example]
notes: []
---
<!-- Calibration example: a historical mapping that worked, written in the template.
     Give it to the red-team agent as a reference for what a real mapping looks like.
     Details are summarised from memory; check them against the papers before relying on them. -->

# C-example: Hamilton's rule applies to siderophore production

## Claim
The kin-selection condition for costly cooperation in animals has the same structure as the
production of iron-scavenging siderophores (pyoverdine) by P. aeruginosa.

## Formalism in the source domain
Hamilton's rule (Hamilton 1964): a costly helping trait spreads when r·b > c.
r = relatedness between actor and recipient, b = benefit to the recipient, c = cost to the actor.

## Mapping
| Source term | Target term | Measurable in target? | Evidence |
|---|---|---|---|
| cooperative act | secreting pyoverdine | yes | |
| cost c | growth cost to the producer | yes: growth of producers vs non-producers in iron-limited media | |
| benefit b | iron gained by neighbours that take up pyoverdine | yes | |
| relatedness r | share of clone-mates in the local group | yes: set by how populations are founded and mixed | |
| cheat | non-producing mutant that still takes up pyoverdine | yes | |

## Assumptions carried over
| Assumption in source | Holds in target? | Evidence |
|---|---|---|
| Benefits go mostly to neighbours, not only the producer | unknown | depends on diffusion and uptake |
| Relatives don't only compete with each other (local competition can cancel the benefit of relatedness) | unknown | known from theory; untested in bacteria at the time |

## Predictions
### P1
- Prediction: producers beat cheats when relatedness is high and lose when it is low.
- Already known in target? no (at the time)
- Test: lab. Competition assays in groups founded at high vs low relatedness.

### P2
- Prediction: the advantage from high relatedness shrinks when competition is local.
- Already known in target? no (at the time)
- Test: lab. Same assays, varying whether groups compete locally or globally.

## Prior art in the target field
| Query | Source searched | Result |
|---|---|---|
| (historical example, not run) | | |

## Red-team log
### R1
- Objection: bacteria don't make decisions, so social theory can't apply.
- Response: Hamilton's rule describes change in gene frequency and needs no cognition.
- Outcome: resolved

### R2
- Objection: if producers take up most of their own pyoverdine, b to others is small and the mapping is weak.
- Response: this is the first assumption row. It is an empirical question, which P1 tests.
- Outcome: open (resolved later by experiment)

## Verdict
The formalism transfers with every variable measurable in the target, and it yields two predictions
that were new to microbiology. Griffin, West & Buckling (Nature, 2004) later tested both and found
higher relatedness favoured siderophore production, more so under global competition. This is the
shape a mapping claim should reach before it counts as `survived`.
