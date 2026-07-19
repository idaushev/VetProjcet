# PROJECT RULES

## Project Type

Offline-first veterinary clinic management system (ERP/PMS).

Main target:
- Android tablets
- Installable PWA
- Unstable or absent internet connection
- Full offline functionality required

---

# Core Architecture Principles

## Offline First

Offline mode is the default operating mode.

The application MUST:
- fully work without internet
- save data locally first
- synchronize later asynchronously
- never block UI because of network errors

Forbidden:
- online-first logic
- direct dependency on API availability
- blocking loaders during sync
- mandatory server requests for core features

Correct flow:

UI
→ Local Database
→ Sync Queue
→ Server

Incorrect flow:

UI
→ API
→ Local Cache

---

# Frontend Rules

Tech stack:
- HTML5
- CSS3
- Vanilla JavaScript preferred
- Service Worker
- IndexedDB
- PWA architecture

Avoid:
- heavy frameworks
- unnecessary libraries
- Redux/MobX
- large UI kits
- overengineered state management

UI requirements:
- tablet-first
- touch-friendly
- minimalistic
- fast rendering
- large controls
- responsive layout

All UI text:
- Russian language

---

# Backend Rules

Backend stack:
- Go
- REST API only
- Monolith architecture

Avoid:
- microservices
- GraphQL
- Kubernetes
- unnecessary abstractions

API principles:
- simple
- predictable
- versioned
- RESTful

---

# Database Rules

Every entity MUST contain:

- local_id
- server_id
- created_at
- updated_at
- deleted_at
- sync_status
- device_id
- version

Soft delete required.

Never physically delete business entities.

---

# Synchronization Rules

Synchronization must be:
- incremental
- queue-based
- fault tolerant

Required support:
- create
- update
- delete

Sync queue must:
- survive application restart
- retry automatically
- support exponential backoff
- store errors

Conflict resolution:
- latest updated_at wins

Never:
- redownload all data
- block application during sync
- lose local changes

---

# Required Tables

## sync_queue

Fields:
- id
- entity_type
- entity_id
- operation_type
- payload
- created_at
- retry_count
- last_error
- status

## sync_state

Fields:
- entity_name
- last_synced_version
- last_synced_at

## devices

Fields:
- id
- device_name
- app_version
- last_sync_at

---

# PWA Rules

Application MUST:
- be installable
- support offline mode
- cache static assets
- use service worker
- support standalone mode

Manifest and service worker are mandatory.

---

# Performance Rules

Prioritize:
- speed
- stability
- low RAM usage
- small bundle size

Target:
- fast startup on weak Android tablets
- responsive UI
- minimal rendering overhead

Avoid:
- large dependencies
- unnecessary animations
- runtime-heavy solutions

---

# Code Style Rules

Code must be:
- production-ready
- modular
- readable
- maintainable

Avoid:
- giant files
- deeply nested logic
- unnecessary abstractions
- dead code

Prefer:
- simple solutions
- incremental refactoring
- explicit logic

---

# Development Workflow

Before implementing any feature:
1. Explain offline behavior
2. Explain local DB changes
3. Explain sync implications
4. Explain API changes
5. Only then generate code

Do NOT:
- rewrite architecture without approval
- replace frameworks without approval
- modify unrelated code

---

# Naming Rules

Database:
- English names only

Code:
- English identifiers only

UI:
- Russian language

Comments:
- Russian language

---

# File Structure

/frontend
/backend
/shared
/docs
/scripts

Keep structure clean and predictable.

---

# Main Priority

Main priority of the entire project:

Reliability of offline operation.

Not visual effects.
Not trendy architecture.
Not enterprise patterns.

The system must continue working even with unstable or completely absent internet.