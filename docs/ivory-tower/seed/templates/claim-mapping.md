---
id: C-001                          # unique within the project
type: mapping
project: project-slug
source_domain: ""                  # where the mechanism is established
target_domain: ""                  # where we propose it applies
status: draft                      # draft | challenged | survived | known | refuted
authored_by: ""                    # task + model, or the owner's name
reviewed_by: []                    # red-team runs, each as task + model
notes: []                          # notes/ files this claim relies on
---
<!-- Gates (agents must enforce these):
     1. Leaving `draft` needs Formalism, Mapping and at least one Prediction filled in.
     2. Reaching `survived` needs a review by a model from a different family than authored_by,
        no `fatal` objections, and at least one prediction marked "Already known: no".
     3. Every factual statement cites a notes/ file. Every note carries a short quote from its source.

     Statuses:
     draft      being written
     challenged red-team objections are open
     survived   objections answered and a novel prediction stands
     known      the target field already has this (record where; this still counts as a result)
     refuted    the formalism doesn't transfer, or a key assumption fails -->

# C-001: short title

## Claim
<!-- One sentence: "[mechanism] in [source] has the same structure as [mechanism] in [target]." -->

## Formalism in the source domain
<!-- The equations, rules or algorithm as established in the source field, with citations.
     If this can't be written down, the analogy is a metaphor. Say so in Verdict and stop. -->

## Mapping
| Source term | Target term | Measurable in target? | Evidence |
|---|---|---|---|
|  |  |  |  |

## Assumptions carried over
<!-- Conditions the source formalism relies on. "Unknown" rows are where the mapping is most
     likely to break, and each one should become a task on the board. -->
| Assumption in source | Holds in target? (yes / no / unknown) | Evidence |
|---|---|---|
|  |  |  |

## Predictions
<!-- What the formalism says should happen in the target that follows from the mapping.
     If every prediction is already known, set status to `known`. -->

### P1
- Prediction:
- Already known in target? no / partly / yes (cite)
- Test: reading / computation / lab. What specifically would be done:

## Prior art in the target field
<!-- Record the searches run, including synonyms the target field might use, and what came back.
     Logging queries lets someone check a "nothing found" result. -->
| Query | Source searched | Result |
|---|---|---|
|  |  |  |

## Red-team log
### R1: task + model, date
- Objection:
- Response:
- Outcome: resolved / open / fatal

## Verdict
<!-- One paragraph: where the claim stands and what the next step is. -->
