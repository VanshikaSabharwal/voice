/**
 * Tool implementations backing the agent's function calls.
 *
 * These run against an in-memory mock dataset so the conversation flow is
 * demonstrable end to end. Swap the bodies for real service-desk API calls
 * without changing the schemas or the executor contract.
 */

export type ToolResult = Record<string, unknown>;

type Customer = {
  customer_id: string;
  name: string;
  phone: string;
  email: string;
  plan: string;
};

type ServiceRequest = {
  request_id: string;
  customer_id: string;
  issue: string;
  status: string;
  priority: string;
  technician: string | null;
  created: string;
  expected_resolution: string;
};

const CUSTOMERS: Customer[] = [
  {
    customer_id: "CUST001",
    name: "Vanshika Sabharwal",
    phone: "+919876543210",
    email: "vanshika@example.com",
    plan: "Premium",
  },
  {
    customer_id: "CUST002",
    name: "Rahul Mehta",
    phone: "+919812345678",
    email: "rahul@example.com",
    plan: "Standard",
  },
];

// Mutable so create_service_request has somewhere to write during a session.
const REQUESTS: ServiceRequest[] = [
  {
    request_id: "SR1234",
    customer_id: "CUST001",
    issue: "Internet connection dropping intermittently",
    status: "In Progress",
    priority: "High",
    technician: "Amit Kumar",
    created: "2026-08-28",
    expected_resolution: "2026-09-05",
  },
  {
    request_id: "SR1235",
    customer_id: "CUST001",
    issue: "Router replacement request",
    status: "Completed",
    priority: "Medium",
    technician: "Priya Sharma",
    created: "2026-08-15",
    expected_resolution: "2026-08-20",
  },
  {
    request_id: "SR2001",
    customer_id: "CUST002",
    issue: "Billing discrepancy on last invoice",
    status: "Open",
    priority: "Low",
    technician: null,
    created: "2026-09-01",
    expected_resolution: "2026-09-10",
  },
];

/** JSON Schema definitions sent to the model, keyed by tool name. */
export const TOOL_SCHEMAS: Record<
  string,
  { description: string; parameters: Record<string, unknown> }
> = {
  get_customer: {
    description:
      "Look up a customer record by customer ID or phone number. Use this to identify the caller before discussing their requests.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID, e.g. CUST001" },
        phone: { type: "string", description: "Phone number in E.164 format" },
      },
      required: [],
    },
  },
  get_service_request: {
    description:
      "Fetch the status and details of an existing service request by its ID. Also accepts a customer_id to list all of that customer's requests.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Request ID, e.g. SR1234" },
        customer_id: {
          type: "string",
          description: "Customer ID, to list all their requests",
        },
      },
      required: [],
    },
  },
  create_service_request: {
    description:
      "Create a new service request for a customer. Confirm the issue description with the caller before calling this.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer ID, e.g. CUST001" },
        issue: { type: "string", description: "Description of the problem" },
        priority: {
          type: "string",
          enum: ["Low", "Medium", "High"],
          description: "Urgency of the request",
        },
      },
      required: ["customer_id", "issue"],
    },
  },
};

function getCustomer(args: Record<string, unknown>): ToolResult {
  const id = typeof args.customer_id === "string" ? args.customer_id : undefined;
  const phone = typeof args.phone === "string" ? args.phone : undefined;

  const match = CUSTOMERS.find(
    (c) =>
      (id && c.customer_id.toLowerCase() === id.toLowerCase()) ||
      // Compare on digits only so "+91 98765 43210" matches "+919876543210".
      (phone && c.phone.replace(/\D/g, "").endsWith(phone.replace(/\D/g, "").slice(-10))),
  );

  if (!match) {
    return { found: false, message: "No customer found with those details." };
  }
  return { found: true, customer: match };
}

function getServiceRequest(args: Record<string, unknown>): ToolResult {
  const requestId =
    typeof args.request_id === "string" ? args.request_id : undefined;
  const customerId =
    typeof args.customer_id === "string" ? args.customer_id : undefined;

  if (requestId) {
    const match = REQUESTS.find(
      (r) => r.request_id.toLowerCase() === requestId.toLowerCase(),
    );
    return match
      ? { found: true, request: match }
      : { found: false, message: `No service request found with ID ${requestId}.` };
  }

  if (customerId) {
    const list = REQUESTS.filter(
      (r) => r.customer_id.toLowerCase() === customerId.toLowerCase(),
    );
    return { found: list.length > 0, count: list.length, requests: list };
  }

  return {
    found: false,
    message: "Provide either a request_id or a customer_id.",
  };
}

function createServiceRequest(args: Record<string, unknown>): ToolResult {
  const customerId =
    typeof args.customer_id === "string" ? args.customer_id : undefined;
  const issue = typeof args.issue === "string" ? args.issue : undefined;
  const priority =
    typeof args.priority === "string" ? args.priority : "Medium";

  if (!customerId || !issue) {
    return { created: false, message: "customer_id and issue are required." };
  }

  const customer = CUSTOMERS.find(
    (c) => c.customer_id.toLowerCase() === customerId.toLowerCase(),
  );
  if (!customer) {
    return { created: false, message: `Unknown customer ${customerId}.` };
  }

  const created = new Date();
  const eta = new Date(created.getTime() + 5 * 24 * 60 * 60 * 1000);
  const request: ServiceRequest = {
    request_id: `SR${Math.floor(3000 + Math.random() * 6999)}`,
    customer_id: customer.customer_id,
    issue,
    status: "Open",
    priority,
    technician: null,
    created: created.toISOString().slice(0, 10),
    expected_resolution: eta.toISOString().slice(0, 10),
  };

  REQUESTS.push(request);
  return { created: true, request };
}

const IMPLEMENTATIONS: Record<string, (a: Record<string, unknown>) => ToolResult> = {
  get_customer: getCustomer,
  get_service_request: getServiceRequest,
  create_service_request: createServiceRequest,
};

/** Run a tool by name. Unknown names return an error object, never throw. */
export function executeTool(
  name: string,
  args: Record<string, unknown>,
): ToolResult {
  const impl = IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  try {
    return impl(args);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Tool failed." };
  }
}
