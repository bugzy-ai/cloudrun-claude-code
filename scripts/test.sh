#!/bin/bash

# Consolidated test script for Claude Code on Cloud Run
# This script combines all testing functionality in one place

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment if available
if [ -f "./scripts/load-env.sh" ]; then
  source "./scripts/load-env.sh"
fi

# Configuration
PROJECT_ID="${PROJECT_ID:-your-project-id}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-qa-agent}"
LOCAL_URL="http://localhost:8080"
REMOTE_URL=""

# Function to print colored messages
print_header() {
  echo -e "\n${BLUE}========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_info() {
  echo -e "${YELLOW}ℹ $1${NC}"
}

# Show usage
usage() {
  cat << EOF
Usage: $0 [OPTIONS] [COMMAND]

COMMANDS:
  auth           Test authentication setup
  local          Test local development server
  remote         Test deployed Cloud Run service
  playwright     Test Playwright MCP on Cloud Run
  remote-async   Test async task execution on Cloud Run
  examples       Show example API requests
  all            Run all tests (default)

OPTIONS:
  -h, --help     Show this help message
  -v, --verbose  Verbose output
  -s, --service  Service URL (for remote testing)

EXAMPLES:
  $0 auth                    # Test authentication
  $0 local                   # Test local server
  $0 remote                  # Test deployed service
  $0 playwright              # Test Playwright MCP
  $0 remote-async            # Test async tasks
  $0 examples                # Show API examples
  $0 all                     # Run all tests

ENVIRONMENT VARIABLES:
  ANTHROPIC_API_KEY          API key for Anthropic API
  CLAUDE_CODE_OAUTH_TOKEN    OAuth token for Claude subscription
  GITHUB_TOKEN               GitHub personal access token
  SERVICE_URL                Override service URL for remote testing
EOF
}

# Test authentication
test_auth() {
  print_header "Testing Authentication"
  
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    print_success "API Key authentication detected"
    echo "  Key prefix: ${ANTHROPIC_API_KEY:0:10}..."
  elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    print_success "OAuth Token authentication detected"
    echo "  Token length: ${#CLAUDE_CODE_OAUTH_TOKEN} characters"
  else
    print_error "No authentication found!"
    echo ""
    echo "To set up authentication:"
    echo "  Option 1: export ANTHROPIC_API_KEY=sk-ant-..."
    echo "  Option 2: export CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token"
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
      echo "Tip: On macOS, retrieve your Claude Code OAuth token with:"
      echo "  security find-generic-password -s \"Claude Code-credentials\" -w"
    fi
    return 1
  fi
  
  # Quick SDK test if local
  if command -v npx &> /dev/null; then
    echo -e "\nTesting SDK authentication..."
    cat > /tmp/test-auth.js << 'EOF'
import { query } from "@anthropic-ai/claude-code";

async function testAuth() {
  try {
    for await (const message of query({ 
      prompt: "Say 'OK' in one word",
      options: { maxTurns: 1, allowedTools: [] }
    })) {
      if (message.type === 'text' && message.text.toLowerCase().includes('ok')) {
        console.log("✓ SDK authentication successful");
        process.exit(0);
      }
    }
  } catch (error) {
    console.error("✗ SDK authentication failed:", error.message);
    process.exit(1);
  }
}
testAuth();
EOF
    npx tsx /tmp/test-auth.js 2>/dev/null || print_error "SDK test failed"
    rm -f /tmp/test-auth.js
  fi
}

# Test local server
test_local() {
  print_header "Testing Local Server"
  
  # Check if server is running
  if ! curl -s -f "${LOCAL_URL}/health" > /dev/null 2>&1; then
    print_error "Local server not running at ${LOCAL_URL}"
    print_info "Start it with: npm run dev"
    return 1
  fi
  
  print_success "Server is running at ${LOCAL_URL}"
  
  # Health check
  echo -e "\n1. Health Check:"
  HEALTH=$(curl -s "${LOCAL_URL}/health")
  if [ "$HEALTH" = "ok" ]; then
    print_success "Health check passed"
  else
    print_error "Health check failed: $HEALTH"
  fi
  
  # Determine which auth to use
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    AUTH_FIELD="\"anthropicApiKey\": \"${ANTHROPIC_API_KEY}\""
  elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    AUTH_FIELD="\"anthropicOAuthToken\": \"${CLAUDE_CODE_OAUTH_TOKEN}\""
  else
    print_error "No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN found"
    print_info "Set one of these environment variables to test API requests"
    return 1
  fi

  # Simple request test
  echo -e "\n2. Testing simple request:"
  RESPONSE=$(curl -s -X POST "${LOCAL_URL}/run" \
    -H "Content-Type: application/json" \
    -d "{
      \"prompt\": \"Say hello in 3 words\",
      ${AUTH_FIELD},
      \"maxTurns\": 1,
      \"allowedTools\": [],
      \"permissionMode\": \"bypassPermissions\"
    }" 2>&1 | head -n 5)

  if echo "$RESPONSE" | grep -q "data:"; then
    print_success "Simple request successful"
  elif echo "$RESPONSE" | grep -q "anthropicApiKey.*required"; then
    print_error "Authentication required"
  else
    print_error "Simple request failed"
    echo "$RESPONSE"
  fi
  
  # Request with tools
  echo -e "\n3. Testing request with tools:"
  RESPONSE=$(curl -s -X POST "${LOCAL_URL}/run" \
    -H "Content-Type: application/json" \
    -d "{
      \"prompt\": \"List files in the current directory\",
      ${AUTH_FIELD},
      \"maxTurns\": 2,
      \"allowedTools\": [\"Bash\"],
      \"permissionMode\": \"bypassPermissions\"
    }" 2>&1 | head -n 10)

  if echo "$RESPONSE" | grep -q "data:"; then
    print_success "Tool request successful"
  else
    print_error "Tool request failed"
    echo "$RESPONSE"
  fi
}

# Test remote service
test_remote() {
  print_header "Testing Remote Cloud Run Service"
  
  # Get service URL if not provided
  if [ -z "$SERVICE_URL" ]; then
    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
      --region="${REGION}" \
      --project="${PROJECT_ID}" \
      --format="value(status.url)" 2>/dev/null) || true
  fi
  
  if [ -z "$SERVICE_URL" ]; then
    print_error "Could not retrieve service URL"
    print_info "Deploy first with: ./scripts/deploy-service.sh"
    return 1
  fi
  
  print_success "Service URL: ${SERVICE_URL}"
  
  # Get auth token
  AUTH_TOKEN=$(gcloud auth print-identity-token 2>/dev/null)
  if [ -z "$AUTH_TOKEN" ]; then
    print_error "Could not get authentication token"
    return 1
  fi
  
  # Health check
  echo -e "\n1. Health Check:"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    "${SERVICE_URL}/health")
  if [ "$HTTP_CODE" = "200" ]; then
    print_success "Health check passed"
  else
    print_error "Health check failed with status: ${HTTP_CODE}"
  fi
  
  # Determine which auth to use for Anthropic API
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    ANTHROPIC_AUTH="\"anthropicApiKey\": \"${ANTHROPIC_API_KEY}\""
  elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    ANTHROPIC_AUTH="\"anthropicOAuthToken\": \"${CLAUDE_CODE_OAUTH_TOKEN}\""
  else
    print_error "No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN found"
    print_info "Set one of these environment variables to test API requests"
    return 1
  fi

  # Test main endpoint
  echo -e "\n2. Testing main endpoint:"
  RESPONSE=$(curl -s -X POST "${SERVICE_URL}/run" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{
      \"prompt\": \"Say hello in 5 words\",
      ${ANTHROPIC_AUTH},
      \"maxTurns\": 1,
      \"allowedTools\": [],
      \"permissionMode\": \"bypassPermissions\"
    }" 2>&1 | head -n 10)

  if echo "$RESPONSE" | grep -q "data:"; then
    echo "$RESPONSE"
    print_success "Main endpoint test successful"
  else
    print_error "Main endpoint test failed"
    echo "$RESPONSE"
  fi

  # Test git repository cloning with public repo
  echo -e "\n3. Testing git repository cloning (public repo):"

  RESPONSE=$(curl -s -X POST "${SERVICE_URL}/run" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{
      \"prompt\": \"List the main files and tell me what this project does\",
      ${ANTHROPIC_AUTH},
      \"gitRepo\": \"https://github.com/anthropics/anthropic-quickstarts\",
      \"gitBranch\": \"main\",
      \"maxTurns\": 2
    }" 2>&1 | head -n 20)

  # Check for successful clone by looking for session init and file listing activity
  if echo "$RESPONSE" | grep -q '"type":"system"' && echo "$RESPONSE" | grep -q '"type":"assistant"'; then
    print_success "Git repository test successful"
  else
    print_error "Git repository test failed"
    echo "$RESPONSE"
  fi

  # Test with SSH key if available
  SSH_KEY_PATH="./tmp/test_key"
  if [ -f "$SSH_KEY_PATH" ] && [ -s "$SSH_KEY_PATH" ]; then
    echo -e "\n4. Testing git repository cloning with SSH key:"

    # Read SSH key and escape for JSON
    SSH_KEY=$(cat "$SSH_KEY_PATH" | sed 's/$/\\n/' | tr -d '\n')

    RESPONSE=$(curl -s -X POST "${SERVICE_URL}/run" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${AUTH_TOKEN}" \
      -d "{
        \"prompt\": \"List the files in this repository and tell me what this project does\",
        ${ANTHROPIC_AUTH},
        \"gitRepo\": \"git@github.com:agent-forge-org/f65adaf3-fc88-4aad-95e0-fd022f43fded-notion-database-viewer.git\",
        \"gitBranch\": \"main\",
        \"sshKey\": \"$SSH_KEY\",
        \"maxTurns\": 2
      }" 2>&1 | head -n 20)

    # Check for successful clone
    if echo "$RESPONSE" | grep -q '"type":"system"' && echo "$RESPONSE" | grep -q '"type":"assistant"'; then
      print_success "Private git repository test successful"
    else
      print_error "Private git repository test failed"
      echo "$RESPONSE"
    fi
  else
    print_info "SSH key not found at $SSH_KEY_PATH - skipping private repo test"
  fi
}

# Test playwright-cli
test_playwright() {
  print_header "Testing playwright-cli on Cloud Run"

  # Get service URL if not provided
  if [ -z "$SERVICE_URL" ]; then
    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
      --region="${REGION}" \
      --project="${PROJECT_ID}" \
      --format="value(status.url)" 2>/dev/null) || true
  fi

  if [ -z "$SERVICE_URL" ]; then
    print_error "Could not retrieve service URL"
    print_info "Deploy first with: ./scripts/deploy-service.sh"
    return 1
  fi

  print_success "Service URL: ${SERVICE_URL}"

  # Get auth token
  AUTH_TOKEN=$(gcloud auth print-identity-token 2>/dev/null)
  if [ -z "$AUTH_TOKEN" ]; then
    print_error "Could not get authentication token"
    return 1
  fi

  # Determine which auth to use for Anthropic API
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    ANTHROPIC_AUTH="\"anthropicApiKey\": \"${ANTHROPIC_API_KEY}\""
  elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    ANTHROPIC_AUTH="\"anthropicOAuthToken\": \"${CLAUDE_CODE_OAUTH_TOKEN}\""
  else
    print_error "No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN found"
    print_info "Set one of these environment variables to test API requests"
    return 1
  fi

  # Test playwright-cli with simple navigation
  echo -e "\n1. Testing playwright-cli - Simple Navigation:"
  print_info "This test will use playwright-cli to navigate to example.com and get the page title"

  RESPONSE=$(curl -s -X POST "${SERVICE_URL}/run" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    --max-time 180 \
    -d "{
      \"prompt\": \"Using playwright-cli, open https://example.com, take a snapshot, and tell me the page title.\",
      ${ANTHROPIC_AUTH},
      \"maxTurns\": 5,
      \"allowedTools\": [\"Bash(playwright-cli:*)\"],
      \"permissionMode\": \"bypassPermissions\"
    }" 2>&1)

  # Check for successful response
  if echo "$RESPONSE" | grep -q '"type":"assistant"' && echo "$RESPONSE" | grep -qi "example"; then
    print_success "playwright-cli test successful"
    echo "$RESPONSE" | grep -o '"text":"[^"]*Example[^"]*"' | head -1 | sed 's/"text"://; s/"//g'
  elif echo "$RESPONSE" | grep -qi "error"; then
    print_error "playwright-cli test failed with error"
    echo "$RESPONSE" | grep -i "error" | head -5
  else
    print_error "playwright-cli test completed but result unclear"
    echo "$RESPONSE" | head -20
  fi
}

# Test remote async endpoint
test_remote_async() {
  print_header "Testing Remote Async Task Execution"

  # Get service URL if not provided
  if [ -z "$SERVICE_URL" ]; then
    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
      --region="${REGION}" \
      --project="${PROJECT_ID}" \
      --format="value(status.url)" 2>/dev/null) || true
  fi

  if [ -z "$SERVICE_URL" ]; then
    print_error "Could not retrieve service URL"
    print_info "Deploy first with: ./scripts/deploy-service.sh"
    return 1
  fi

  print_success "Service URL: ${SERVICE_URL}"

  # Get auth token
  AUTH_TOKEN=$(gcloud auth print-identity-token 2>/dev/null)
  if [ -z "$AUTH_TOKEN" ]; then
    print_error "Could not get authentication token"
    return 1
  fi

  # Check if GCS_LOGS_BUCKET is configured
  if [ -z "${GCS_LOGS_BUCKET}" ]; then
    print_error "GCS_LOGS_BUCKET not configured in .env"
    print_info "Async task support requires a GCS bucket"
    print_info "Add GCS_LOGS_BUCKET to your .env and run ./scripts/update-service-account-permissions.sh"
    return 1
  fi

  print_info "GCS Logs Bucket: ${GCS_LOGS_BUCKET}"

  # Determine which auth to use for Anthropic API
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    ANTHROPIC_AUTH="\"anthropicApiKey\": \"${ANTHROPIC_API_KEY}\""
  elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    ANTHROPIC_AUTH="\"anthropicOAuthToken\": \"${CLAUDE_CODE_OAUTH_TOKEN}\""
  else
    print_error "No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN found"
    print_info "Set one of these environment variables to test API requests"
    return 1
  fi

  # Test async endpoint with callback URL (using webhook.site or similar)
  echo -e "\n1. Testing async task creation:"

  # Use a simple callback URL (httpbin.org/post for testing)
  CALLBACK_URL="https://httpbin.org/post"

  RESPONSE=$(curl -s -X POST "${SERVICE_URL}/run-async" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{
      \"prompt\": \"Say hello in 3 words and explain why you chose those words\",
      ${ANTHROPIC_AUTH},
      \"callbackUrl\": \"${CALLBACK_URL}\",
      \"maxTurns\": 1,
      \"allowedTools\": [],
      \"permissionMode\": \"bypassPermissions\",
      \"metadata\": {
        \"test\": \"remote-async\",
        \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
      }
    }" 2>&1)

  # Parse response
  if echo "$RESPONSE" | grep -q '"taskId"'; then
    TASK_ID=$(echo "$RESPONSE" | grep -o '"taskId":"[^"]*"' | cut -d'"' -f4)
    LOGS_PATH=$(echo "$RESPONSE" | grep -o '"logsPath":"[^"]*"' | cut -d'"' -f4)

    print_success "Async task created successfully"
    echo "  Task ID: ${TASK_ID}"
    echo "  Logs Path: ${LOGS_PATH}"
    echo "  Callback URL: ${CALLBACK_URL}"

    echo -e "\n2. Task execution details:"
    print_info "Task is executing in background"
    print_info "When complete, results will be POSTed to callback URL"
    print_info "Logs are being streamed to: ${LOGS_PATH}"

    echo -e "\n3. To view logs in real-time:"
    echo "  gcloud storage cat ${LOGS_PATH}*.jsonl"

    echo -e "\n4. To check task status:"
    echo "  gcloud storage ls ${LOGS_PATH}"
    echo "  gcloud storage cat ${LOGS_PATH}metadata.json"

  elif echo "$RESPONSE" | grep -q "GCS_LOGS_BUCKET.*not configured"; then
    print_error "Async tasks not configured on service"
    print_info "Set GCS_LOGS_BUCKET environment variable in Cloud Run"
    echo "$RESPONSE"
  else
    print_error "Async task creation failed"
    echo "$RESPONSE"
  fi
}

# Show examples
show_examples() {
  print_header "API Request Examples"
  
  cat << 'EOF'
1. SIMPLE REQUEST
-----------------
# With API Key
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Write a test plan for login functionality",
    "anthropicApiKey": "sk-ant-your-key-here",
    "maxTurns": 3
  }'

# With OAuth Token
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Write a test plan for login functionality",
    "anthropicOAuthToken": "your-oauth-token-here",
    "maxTurns": 3
  }'

2. WITH GITHUB MCP SERVER
-------------------------
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Review the latest PRs",
    "anthropicApiKey": "sk-ant-your-key-here",
    "maxTurns": 5,
    "mcpConfigJson": {
      "mcpServers": {
        "github": {
          "type": "stdio",
          "command": "npx",
          "args": ["@modelcontextprotocol/server-github@latest"],
          "env": {"GITHUB_TOKEN": "ghp_YOUR_TOKEN"}
        }
      }
    },
    "allowedTools": ["mcp__github__*"],
    "permissionMode": "bypassPermissions"
  }'

3. WITH MULTIPLE MCP SERVERS
----------------------------
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Check GitHub issues and create JIRA tickets",
    "anthropicApiKey": "sk-ant-your-key-here",
    "systemPrompt": "You are a QA engineer",
    "maxTurns": 8,
    "mcpConfigJson": {
      "mcpServers": {
        "github": {
          "type": "stdio",
          "command": "npx",
          "args": ["@modelcontextprotocol/server-github@latest"],
          "env": {"GITHUB_TOKEN": "ghp_YOUR_TOKEN"}
        },
        "jira": {
          "type": "stdio",
          "command": "npx",
          "args": ["@modelcontextprotocol/server-jira@latest"],
          "env": {
            "JIRA_API_TOKEN": "YOUR_TOKEN",
            "JIRA_EMAIL": "you@company.com",
            "JIRA_BASE_URL": "https://company.atlassian.net"
          }
        }
      }
    },
    "allowedTools": ["mcp__github__*", "mcp__jira__*"],
    "permissionMode": "acceptEdits"
  }'

4. WITH FILE OPERATIONS
-----------------------
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a test suite for the checkout process",
    "anthropicApiKey": "sk-ant-your-key-here",
    "maxTurns": 6,
    "allowedTools": ["Read", "Write", "Grep", "LS"],
    "permissionMode": "acceptEdits",
    "cwdRelative": "./tests"
  }'

5. WITH WEB SEARCH
-----------------
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Research best practices for API testing in 2024",
    "anthropicApiKey": "sk-ant-your-key-here",
    "maxTurns": 5,
    "allowedTools": ["WebSearch", "WebFetch", "Write"],
    "permissionMode": "bypassPermissions"
  }'

6. WITH GIT REPOSITORY
---------------------
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "List the files and explain what this project does",
    "anthropicApiKey": "sk-ant-your-key-here",
    "gitRepo": "https://github.com/owner/repo",
    "gitBranch": "main",
    "maxTurns": 3,
    "allowedTools": ["Read", "Grep", "Bash(ls:*)"],
    "permissionMode": "acceptEdits"
  }'

7. WITH PRE-EXECUTION COMMANDS
------------------------------
curl -N -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Run the test suite and fix any failures",
    "anthropicApiKey": "sk-ant-your-key-here",
    "gitRepo": "https://github.com/owner/frontend-app",
    "gitBranch": "main",
    "preExecutionCommands": [
      "npm ci",
      "npx playwright install --with-deps"
    ],
    "environmentSecrets": {
      "CI": "true"
    },
    "maxTurns": 20,
    "allowedTools": ["Read", "Write", "Edit", "Bash"],
    "permissionMode": "bypassPermissions"
  }'

# Pre-execution commands run AFTER git clone, BEFORE Claude starts
# Commands execute sequentially - any failure stops the entire request
# Common use cases: npm install, playwright install, build scripts

8. FOR CLOUD RUN (with auth)
----------------------------
AUTH_TOKEN=$(gcloud auth print-identity-token)
curl -N -X POST https://your-service-url/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -d '{
    "prompt": "Your prompt here",
    "anthropicApiKey": "sk-ant-your-key-here",
    "allowedTools": ["Read", "Write"],
    "permissionMode": "acceptEdits"
  }'

NOTES:
- anthropicApiKey or anthropicOAuthToken is REQUIRED in all requests
- Use anthropicApiKey for API keys from console.anthropic.com
- Use anthropicOAuthToken for OAuth tokens from Claude subscription
- Environment variables can be set: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
EOF

  print_info "Save these examples to a file for reference"
  print_info "Remember to replace tokens and URLs with your actual values"
}

# Main script
main() {
  # Default to 'all' if no command specified
  COMMAND="${1:-all}"
  
  case "$COMMAND" in
    auth)
      test_auth
      ;;
    local)
      test_local
      ;;
    remote)
      test_remote
      ;;
    playwright)
      test_playwright
      ;;
    remote-async)
      test_remote_async
      ;;
    examples)
      show_examples
      ;;
    all)
      test_auth
      test_local
      test_remote
      test_remote_async
      echo ""
      print_header "Test Summary"
      print_success "All tests completed"
      print_info "Run '$0 examples' to see API request examples"
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      print_error "Unknown command: $COMMAND"
      usage
      exit 1
      ;;
  esac
}

# Run main function
main "$@"