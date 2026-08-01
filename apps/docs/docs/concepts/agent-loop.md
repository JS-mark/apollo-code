# Agent loop

One turn moves through a small set of boundaries: the runner composes trusted instructions, the router chooses a provider, provider output may request a tool, and the permission layer decides whether the tool may run. Tool results return to the model until it finishes or reaches the loop limit.

The event stream lets the terminal UI, local storage, and telemetry observe the run without those packages mutating core session state. Interrupting a turn aborts in-flight provider and tool work while keeping the session available.
