# Product Requirements Document (PRD): Instruction Processing Module

## 1. Introduction
This module provides a dedicated "Run Mode" interface for YoRHa-HexFlow operators. It decouples the *definition* of an instruction (structure/schema) from its *execution* (parameter filling/sending). The primary goal is operational efficiency and error reduction during manual command transmission.

## 2. User Stories

| ID | Persona | Scenario | Action | Benefit |
| :--- | :--- | :--- | :--- | :--- |
| US-01 | **Operator** | Routine maintenance checks. | Selects a stored command (e.g., "Motor Start") and inputs specific parameters (Speed: 500). | Eliminates the need to reconstruct the command byte-by-byte. |
| US-02 | **Operator** | High-pressure debugging. | Quickly creates valid bytecode for complex dependency chains (A=Len(B)) without manual calculation. | Prevents protocol errors caused by manual math. |
| US-03 | **Developer** | Protocol testing. | Views the real-time Hex update while typing parameters. | Confirms that the input maps to the correct byte location. |

## 3. Functional Requirements

### 3.1 Input/Configuration
- **FR-01: Schema Loading**
    - The system MUST load the `InstructionDefinition` from the central store.
    - The system MUST identify all fields marked as `Variable` or `Input`.
- **FR-02: Dynamic Form Generation**
    - For each variable field, the UI MUST render an appropriate input widget (Text, Number, Select).
    - **Default Values**: If a default is defined in the schema, it MUST be pre-filled.
- **FR-03: Reactive Dependency Resolution**
    - **Logic**: If Field A has a formula depending on Field B (e.g., `[Len] = Body.length`), changing Field B MUST update Field A immediately.
    - **Latency**: Update propagation MUST occur within 16ms (1 frame) of input event.

### 3.2 Output Generation
- **FR-04: Hex Compilation**
    - The system MUST generate a valid Hexadecimal string compliant with the Instruction Schema.
    - **Padding**: Values MUST be zero-padded to their specific `byte_len`.
    - **Endianness**: MUST respect the global or per-field endianness setting (Default: Big Endian).
- **FR-05: Transmission**
    - The system MUST provide a "Send" action.
    - **Payload**: The payload MUST be the raw byte array (or hex representation).
    - **Logging**: A local session log MUST record the Timestamp, Instruction Name, and Sent Payload.

### 3.3 Error Handling
- **ER-01: Validation**
    - **Range**: If a user inputs `256` for a 1-byte field (max 255), the UI MUST block the input or visually indicate "Overflow".
    - **Type**: Non-numeric characters in numeric fields MUST be ignored or flagged.
- **ER-02: Formula Errors**
    - If a formula cannot be resolved (e.g., division by zero), the result MUST default to `0` and display a warning icon.

## 4. Data Model (Transient)

The "Processing Page" is stateless, but it operates on these conceptual models:

### 4.1 ProcessingContext
```typescript
interface ProcessingContext {
  instructionId: string;       // Reference to the blueprint
  userInputs: Record<string, any>; // Key: Field ID, Value: User Input
  computedValues: Record<string, string>; // Key: Field ID, Value: Calculated Hex
  hexPreview: string;          // The final full string
}
```

## 5. Non-functional Requirements

### 5.1 Performance
- **Render Time**: Switching selected instructions MUST take < 200ms.
- **Typing Latency**: Keystroke to Hex Preview update MUST be < 50ms.

### 5.2 Usability
- **Keyboard Navigation**: All input fields MUST be focusable via `Tab`.
- **Shortcut**: `Ctrl+Enter` MUST trigger the "Send" action.

### 5.3 Reliability
- **Isolation**: Processing one instruction MUST NOT affect the state of others.
- **Robustness**: The encoder MUST NOT crash the UI thread even with invalid formula inputs (e.g., infinite recursion protection).
