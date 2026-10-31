---
slug: sample-pheromone-routing
title: "Sample: pheromone trails as a routing protocol"
disciplines: [entomology, network-engineering]
board: ""
validation_tier: reading
created: 2026-09-24
---
<!-- No status field. Status lives on the board only. -->

# Sample: pheromone trails as a routing protocol

## Question
Does the reinforcement and evaporation of ant pheromone trails have the same structure as a
distance-vector routing protocol with route ageing?

## Why this might be new
This is a sample project. The idea is almost certainly known already (ant colony optimisation,
AntNet), which makes it a good test of the planner's first job: finding that out quickly.

## Scope
In: trail reinforcement, evaporation rate, path choice in foraging ants; routing table updates
and route expiry in packet networks.
Out: anything needing lab work or simulation.

## Done when
A `known` verdict that names where the target field already has this, or a mapping claim that
reaches `survived`.

## Kill criteria
The networking literature already describes pheromone-style routing under another name.

## Starting points
Dorigo and Stützle, *Ant Colony Optimization* (2004). Di Caro and Dorigo, "AntNet" (1998).

## Notes for the planner
Keep it to reading. Stop at the first solid prior-art hit.
