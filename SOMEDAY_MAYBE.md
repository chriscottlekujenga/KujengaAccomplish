# Someday / Maybe — KujengaAccomplish

Deferred feature ideas only. **Listing an idea here does not authorize implementation, deployment, or spending.** Revisit when explicitly prioritized.

## 1. Optional employee remote desktop access

- **Status:** Deferred / low priority.
- **Goal:** Let employees remotely access their work computers when the Accomplish interface or WhatsApp approval is insufficient.
- **Windows x64:** Consider optional RustDesk setup/integration.
- **macOS Intel and Apple Silicon:** Consider optional RustDesk setup/integration after compatibility and security validation.
- **Ubuntu ARM64:** Preserve the existing GNOME Remote Desktop + Android aRDP workflow; no RustDesk testing requested.
- **Linux x64:** Not decided.
- **Constraints:** Optional, no custom remote-desktop protocol, no dependency for core Accomplish. Assess per-user access controls, authentication, encryption, and unattended-access risks before activation.

## 2. WhatsApp reminders and scheduled-task communication via a shared cloud service

- **Status:** Someday / Maybe — not part of the initial WhatsApp human-oversight phase.
- **Goal:** Allow a user to explicitly ask Accomplish to send WhatsApp reminders, recurring reminders, and scheduled-task status messages.
- **Future architecture:** A centrally hosted, authenticated service connecting users' Accomplish installations, storing schedules and delivering communications even when an employee's computer is offline.
- **Cloud-executable jobs:** Only specifically supported cloud-side tasks may execute while the local computer is off.
- **Local-computer jobs:** If the computer is off, queue or mark the job pending; resume only when it reconnects and its existing authorization remains valid. Do not claim local work ran while offline.
- **Explore later:** Multi-tenant isolation, opt-in and consent, per-user time zones, scheduling reliability, duplicate suppression, encrypted data storage, retention, billing, delivery failures, and secure WhatsApp provider integration.
- **Boundary:** Scheduled messages must not create an unrestricted remote command channel or bypass model-spending and permission approvals.

## Active-phase design note (NOT Someday / Maybe)

The initial WhatsApp human-oversight phase remains planned **after** adaptive routing/delegation implementation and testing. It is limited to permissions, decision moments, premium-model budget approvals, and completion/failure/milestone alerts. Design requirements agreed:

- Per-user **WhatsApp on/off** master switch; off disables outbound notifications and incoming remote approvals without disabling local Accomplish approvals.
- Separate **disconnect/revoke** action from temporary off; preserve configuration when merely switched off.
- **Standard** notification frequency by default: approvals, decisions, failures, significant milestones, and project completion.
- **Numbered replies** for request-specific decisions and approvals.
- Remote destructive-operation approvals can be supported with risk-appropriate detailed confirmation and stronger phone-accessible verification, rather than a blanket desktop-only restriction.
- Never treat these design notes as permission to start implementing WhatsApp before the current phase is tested and approved.
