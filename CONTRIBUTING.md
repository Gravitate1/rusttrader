# Contributing to Rust Trader

Thank you for your interest in contributing to Rust Trader! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies with `npm install`
4. Make your changes
5. Test thoroughly
6. Submit a pull request

## Development Setup

```bash
# Clone your fork
git clone https://github.com/bzonca/rusttrader.git
cd rust-trader-electron

# Install dependencies
npm install

# Run the app in development mode
npm start
```

## Code Style

- Use 2-space indentation
- Follow existing code patterns
- Add comments for complex logic
- Keep functions focused and single-purpose
- Use descriptive variable names

## Areas for Contribution

Here are some areas where contributions would be especially welcome:

### Features
- Real-time vending machine updates (WebSocket connection)
- Export data to CSV/JSON
- Price history tracking
- Shop favorites/bookmarks
- Map visualization of vending machines
- Multi-language support
- Dark/light theme toggle improvements

### Bug Fixes
- Check the Issues page for reported bugs
- Test edge cases and improve error handling
- Improve connection stability

### Documentation
- Add screenshots to README
- Improve code comments
- Write tutorials or guides
- Translate documentation

### Performance
- Optimize rendering of large shop lists
- Improve search/filter performance
- Reduce memory usage

## Testing Your Changes

Before submitting a PR:

1. **Test pairing**: Ensure server pairing still works
2. **Test vending data**: Verify all vending data displays correctly
3. **Test filtering**: Check all search and filter combinations
4. **Test themes**: Ensure all themes work properly
5. **Test error cases**: Try disconnecting, invalid servers, etc.

## Pull Request Process

1. **Update documentation** if you've changed functionality
2. **Add/update comments** in your code
3. **Test thoroughly** on your local machine
4. **Describe your changes** clearly in the PR description
5. **Reference any issues** your PR addresses

### PR Title Format
- `feat: Add price history tracking`
- `fix: Resolve pairing timeout issue`
- `docs: Update installation instructions`
- `style: Improve modern theme colors`
- `refactor: Simplify distance calculation`

## Code Review

- All PRs require review before merging
- Be open to feedback and suggestions
- Respond to review comments promptly
- Be patient - maintainers are volunteers

## Reporting Bugs

When reporting bugs, please include:

1. **Clear description** of the issue
2. **Steps to reproduce** the problem
3. **Expected behavior** vs actual behavior
4. **Screenshots** if applicable
5. **Environment details**:
   - OS (Windows/Mac/Linux)
   - Electron version
   - Node.js version
   - App version

## Feature Requests

Feature requests are welcome! Please:

1. Check if the feature already exists or is planned
2. Describe the feature clearly
3. Explain the use case
4. Consider contributing the feature yourself!

## Technical Architecture

Understanding the codebase:

### Main Process (`main.js`)
- Handles IPC communication
- Manages FCM credentials
- Fetches item data from Corrosion Hour
- Connects to Rust+ servers
- Stores server data locally
- Enriches vending data via `enrichOffersWithRelativeCost()` from `market-rates.js` before sending to the renderer

### Market rates (`market-rates.js`)
- Builds a server-derived exchange graph from live vending listings
- Selects a base currency (typically Scrap) and resolves multi-hop rates
- Adds `relativeCost`, `relativeValue`, `relativeSpread`, and related fields to each offer
- Leaves fields blank when graph confidence is insufficient (never guesses)

### Renderer Process (`renderer.js`)
- UI logic and event handling
- Filtering and searching
- Theme management
- Display formatting
- Click-to-sort shop table columns and base-currency hint for relative pricing

### Preload Script (`preload.js`)
- Secure bridge between main and renderer
- Exposes safe IPC methods via `window.electronAPI`

### Key Dependencies
- `@liamcottle/rustplus.js` - Rust+ protocol
- `@liamcottle/push-receiver` - FCM notifications
- `cheerio` - HTML parsing for item data

### Testing
- Run `npm test` before submitting a PR (market-rates unit tests)
- Follow the manual checklist in **Testing Your Changes** above for pairing, UI, and themes

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open an issue for any questions about contributing!

---

Thank you for making Rust Trader better! 🎮
