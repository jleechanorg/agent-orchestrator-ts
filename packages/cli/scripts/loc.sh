#!/bin/bash

# ==============================================================================
# Complete GitHub Statistics Script
#
# Description:
# This script provides comprehensive GitHub development analysis including:
# 1. Lines of code breakdown by language and test vs non-test
# 2. Commit statistics and categorization
# 3. Pull request analysis and types
# 4. Code change metrics (excluding vendor files)
# 5. Daily averages and productivity metrics
#
# Usage:
# ./loc.sh [date]           # Show complete GitHub statistics since date
# ./loc.sh --help           # Show this help
# ==============================================================================

# Check if help is requested
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "Usage: $0 [date] [options]"
    echo "  date: Optional date in YYYY-MM-DD format (defaults to 30 days ago)"
    echo ""
    echo "Options:"
    echo "  --help, -h       Show this help"
    echo "  --no-loc         Skip lines of code analysis"
    echo "  --single-repo    Analyze only current repository"
    echo ""
    echo "Examples:"
    echo "  ./loc.sh                    # Last 30 days with LOC analysis"
    echo "  ./loc.sh 2025-06-01         # Since June 1st, 2025"
    echo "  ./loc.sh --no-loc           # Skip LOC analysis"
    exit 0
fi

# Check if Python script exists
PYTHON_SCRIPT="scripts/analyze_git_stats.py"
if [[ ! -f "$PYTHON_SCRIPT" ]]; then
    echo "❌ Error: $PYTHON_SCRIPT not found!"
    echo "Please ensure you're running from the project root directory."
    exit 1
fi

# Pass all arguments to the Python script with --single-repo flag
python3 "$PYTHON_SCRIPT" --single-repo "$@"
