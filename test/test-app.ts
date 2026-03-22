/**
 * Simple test web app using Node's built-in http module.
 * Pages: Home, Login, Signup, Dashboard (auth-gated), About
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';

const PAGES: Record<string, string> = {
  '/': `<!DOCTYPE html>
<html><head><title>Test App - Home</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/about">About</a> | <a href="/login">Login</a> | <a href="/signup">Sign Up</a>
  </nav></header>
  <main>
    <h1>Welcome to Test App</h1>
    <p>This is a simple test application for Replaybot.</p>
    <ul>
      <li><a href="/products">Products</a></li>
      <li><a href="/contact">Contact</a></li>
    </ul>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,

  '/about': `<!DOCTYPE html>
<html><head><title>Test App - About</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/about">About</a> | <a href="/login">Login</a> | <a href="/signup">Sign Up</a>
  </nav></header>
  <main>
    <h1>About Us</h1>
    <p>We are a test company.</p>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,

  '/login': `<!DOCTYPE html>
<html><head><title>Test App - Login</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/about">About</a> | <a href="/login">Login</a> | <a href="/signup">Sign Up</a>
  </nav></header>
  <main>
    <h1>Login</h1>
    <form id="login-form" action="/dashboard" method="get">
      <label for="email">Email:</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required>
      <br>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" placeholder="password" required>
      <br>
      <button type="submit">Log In</button>
    </form>
    <p>Don't have an account? <a href="/signup">Sign up</a></p>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,

  '/signup': `<!DOCTYPE html>
<html><head><title>Test App - Sign Up</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/about">About</a> | <a href="/login">Login</a> | <a href="/signup">Sign Up</a>
  </nav></header>
  <main>
    <h1>Create Account</h1>
    <form id="signup-form" action="/dashboard" method="get">
      <label for="name">Full Name:</label>
      <input type="text" id="name" name="name" placeholder="John Doe" required>
      <br>
      <label for="signup-email">Email:</label>
      <input type="email" id="signup-email" name="email" placeholder="you@example.com" required>
      <br>
      <label for="signup-password">Password:</label>
      <input type="password" id="signup-password" name="password" placeholder="min 8 characters" required>
      <br>
      <label for="confirm-password">Confirm Password:</label>
      <input type="password" id="confirm-password" name="confirm_password" required>
      <br>
      <select id="role" name="role">
        <option value="user">User</option>
        <option value="admin">Admin</option>
      </select>
      <br>
      <button type="submit">Create Account</button>
    </form>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,

  '/dashboard': `<!DOCTYPE html>
<html><head><title>Test App - Dashboard</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/dashboard">Dashboard</a> | <a href="/products">Products</a> | <a href="/settings">Settings</a>
  </nav></header>
  <main>
    <h1>Dashboard</h1>
    <p>Welcome back!</p>
    <div id="stats">
      <div><strong>Orders:</strong> 5</div>
      <div><strong>Messages:</strong> 3</div>
    </div>
    <button id="refresh-btn" onclick="document.getElementById('stats').style.background='#eee'">Refresh</button>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,

  '/products': `<!DOCTYPE html>
<html><head><title>Test App - Products</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/about">About</a> | <a href="/products">Products</a>
  </nav></header>
  <main>
    <h1>Products</h1>
    <ul>
      <li><a href="/products/1">Widget A - $10</a></li>
      <li><a href="/products/2">Widget B - $20</a></li>
      <li><a href="/products/3">Gadget C - $30</a></li>
    </ul>
    <form id="search-form">
      <input type="text" id="search" name="q" placeholder="Search products...">
      <button type="submit">Search</button>
    </form>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,

  '/contact': `<!DOCTYPE html>
<html><head><title>Test App - Contact</title></head>
<body>
  <header><nav>
    <a href="/">Home</a> | <a href="/about">About</a> | <a href="/contact">Contact</a>
  </nav></header>
  <main>
    <h1>Contact Us</h1>
    <form id="contact-form">
      <label for="contact-name">Name:</label>
      <input type="text" id="contact-name" name="name" required>
      <br>
      <label for="contact-email">Email:</label>
      <input type="email" id="contact-email" name="email" required>
      <br>
      <label for="message">Message:</label>
      <textarea id="message" name="message" rows="5" required></textarea>
      <br>
      <button type="submit">Send Message</button>
    </form>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`,
};

export function startTestApp(port = 3456): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url?.split('?')[0] ?? '/';
      const html = PAGES[url];

      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else if (url.startsWith('/products/')) {
        const id = url.split('/')[2];
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><title>Product ${id}</title></head>
<body>
  <header><nav><a href="/">Home</a> | <a href="/products">Products</a></nav></header>
  <main>
    <h1>Product ${id}</h1>
    <p>Price: $${Number(id) * 10}</p>
    <button id="add-to-cart">Add to Cart</button>
    <a href="/products">Back to Products</a>
  </main>
  <footer><p>&copy; 2024 Test App</p></footer>
</body></html>`);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      }
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startTestApp();
  console.log('Test app running at http://localhost:3456');
}
