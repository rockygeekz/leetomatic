import fetch from 'node-fetch';
import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

const SESSION_COOKIE = process.env.SESSION_COOKIE;
const GT_TOKEN = process.env.GT_TOKEN;

if (!SESSION_COOKIE) {
    throw new Error('SESSION_COOKIE is not set');
}

if (!GT_TOKEN) {
    throw new Error('GT_TOKEN is not set');
}

// Public repository details
const REPO_OWNER = 'kamyu104';
const REPO_NAME = 'LeetCode-Solutions';

// Function to check session validity
const checkSessionValidity = async () => {
    const url = 'https://leetcode.com/api/problems/all/';
    const response = await fetch(url, {
        headers: {
            'Cookie': `LEETCODE_SESSION=${SESSION_COOKIE}`,
        },
    });

    if (response.status === 200) {
        const data = await response.json();
        return data.user_name; // Valid session returns user info
    }
    return null; // Session is invalid
};

// Fetch LeetCode Problem of the Day
const fetchLeetCodeDailyProblem = async () => {
    const url = 'https://leetcode.com/graphql';
    const query = `
        query questionOfTheDay {
          activeDailyCodingChallengeQuestion {
            question {
              title
              titleSlug
            }
          }
        }
    `;

    try {
        console.log("Fetching LeetCode Problem of the Day...");
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });

        const data = await response.json();
        if (data.errors) throw new Error(JSON.stringify(data.errors));

        const problem = data.data.activeDailyCodingChallengeQuestion;
        if (!problem) throw new Error("No problem found.");

        const { title, titleSlug } = problem.question;
        console.log(`Problem Fetched: ${title} - https://leetcode.com/problems/${titleSlug}/`);
        return titleSlug;
    } catch (error) {
        console.error("Error fetching LeetCode problem:", error);
        process.exit(1);
    }
};

// Function to search for a solution file in the repository
const searchSolutionFile = async (problemTitle) => {
    const normalizedTitle = problemTitle.replace(/ /g, '-');
    const query = `filename:${normalizedTitle}.cpp repo:${REPO_OWNER}/${REPO_NAME}`;
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}`;

    try {
        console.log(`Making request to GitHub API: ${url}`);
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${GT_TOKEN}`,
            },
        });

        console.log(`Response Status: ${response.status}`);

        if (!response.ok) {
            const errorData = await response.json();
            console.error(`GitHub API error data:`, errorData);
            throw new Error(`GitHub API error: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.total_count === 0) {
            throw new Error(`No solution found for problem: ${problemTitle}`);
        }

        const file = data.items.find((item) => {
            return item.path.toLowerCase().includes(normalizedTitle.toLowerCase());
        });

        if (!file) {
            throw new Error(`No relevant solution file found for problem: ${problemTitle}`);
        }

        const rawUrl = file.html_url
            .replace('github.com', 'raw.githubusercontent.com')
            .replace('/blob/', '/');

        return rawUrl;
    } catch (error) {
        console.error(`Error searching for solution: ${error.message}`);
        process.exit(1);
    }
};

// Function to fetch raw content from a GitHub URL
const fetchRawContent = async (url) => {
    try {
        console.log(`Fetching raw content from: ${url}`);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to fetch raw content: ${response.statusText}`);
        }

        return await response.text();
    } catch (error) {
        console.error(`Error fetching raw content: ${error.message}`);
        process.exit(1);
    }
};

// Function to extract the first solution from the file content
const extractSolutionClass = (fileContent) => {
    const startMarker = 'class Solution';
    const startIndex = fileContent.indexOf(startMarker);

    if (startIndex === -1) {
        throw new Error('No solution found in the file.');
    }

    let depth = 0;
    let endIndex = startIndex;

    for (let i = startIndex; i < fileContent.length; i++) {
        if (fileContent[i] === '{') {
            depth++;
        } else if (fileContent[i] === '}') {
            depth--;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
    }

    if (depth !== 0) {
        throw new Error('Unbalanced braces in the solution class.');
    }

    const semicolonIndex = fileContent.indexOf(';', endIndex);
    if (semicolonIndex === -1) {
        throw new Error('Semicolon not found after the closing brace.');
    }

    const firstSolution = fileContent.slice(startIndex, semicolonIndex + 1);
    return firstSolution.trim();
};

// Function to remove comments from C++ code
const removeComments = (code) => {
    return code
        .replace(/\/\/.*$/gm, '')  // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove multi-line comments
        .replace(/^\s*[\r\n]/gm, '')  // Remove empty lines
        .trim();
};

// Retry mechanism for Playwright actions
const retry = async (fn, retries = 3, delay = 5000) => {
    try {
        return await fn();
    } catch (error) {
        if (retries > 0) {
            console.log(`Retrying... ${retries} attempts left`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return await retry(fn, retries - 1, delay);
        } else {
            throw error;
        }
    }
};

// Submit the extracted C++ solution to LeetCode
const submitToLeetCode = async (code, leetcodeUrl) => {
    console.log("Submitting code to LeetCode...");

    let browser;
    let page;

    try {
        if (!leetcodeUrl || !/^https:\/\/leetcode\.com\/.*$/.test(leetcodeUrl)) {
            throw new Error("Invalid LeetCode URL: " + leetcodeUrl);
        }

        // Launch Playwright with headless mode and additional arguments
        browser = await chromium.launch({
            headless: false, // Keep it headless
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled', // Disable headless detection
            ],
        });

        const context = await browser.newContext();

        // Set a real user agent
        await context.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        });

        page = await context.newPage();

        // Set the session cookie
        await context.addCookies([{
            name: 'LEETCODE_SESSION',
            value: SESSION_COOKIE,
            domain: 'leetcode.com',
            path: '/',
        }]);

        console.log(`Navigating to: ${leetcodeUrl}`);
        await page.goto(leetcodeUrl, { waitUntil: 'networkidle' });
        console.log('Navigated successfully!');

        // Check if redirected to login page
        const currentUrl = page.url();
        if (currentUrl.includes('accounts')) {
            console.log('Redirected to login page. Check your session cookie.');
            await browser.close();
            throw new Error('Session cookie is invalid or expired.');
        }

        // Wait for the editor to load
        await retry(async () => {
            console.log('Waiting for editor to load...');
            await page.waitForSelector('.monaco-editor', { timeout: 60000 });
            console.log('Editor loaded!');
        });

        // Scroll the page to ensure all elements are visible
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });

        // Add a random delay to mimic human behavior
        const delay = Math.floor(Math.random() * 3000) + 1000; // Random delay between 1-4 seconds
        await page.waitForTimeout(delay);

        // Inject the code into the editor
        await page.evaluate((code) => {
            const editor = monaco.editor.getModels()[0];
            editor.setValue(code);
        }, code);

        console.log("Code injected into editor.");

        // Add another random delay before submitting
        await page.waitForTimeout(delay);

        // Submit the code
        console.log('Clicking the submit button...');
        await page.click('[data-e2e-locator="console-submit-button"]');
        await page.waitForTimeout(5000); // Wait for submission to complete

        console.log("Code submitted successfully!");
    } catch (error) {
        console.error("Error submitting code to LeetCode:", error);

        // Capture console logs and network activity for debugging
        if (page) {
            page.on('console', msg => console.log('Console log:', msg.text()));
            page.on('requestfailed', request => {
                console.log('Request failed:', request.url(), request.failure().errorText);
            });
        }
    } finally {
        // Close the browser
        if (browser) {
            await browser.close();
        }
    }
};

// Main Flow
(async () => {
    try {
        // Step 0: Check session validity
        const isValidSession = await checkSessionValidity();
        if (!isValidSession) {
            console.error('Session is invalid. Please update the SESSION_COOKIE in GitHub Secrets.');
            process.exit(1);
        }

        // Step 1: Fetch the daily problem
        const problemSlug = await fetchLeetCodeDailyProblem();
        const problemTitle = problemSlug.replace(/-/g, ' ');
        const leetcodeUrl = `https://leetcode.com/problems/${encodeURIComponent(problemSlug)}/`;

        console.log(`Searching for solution to problem: ${problemTitle}...`);

        // Step 2: Search for the solution file in the repository
        const rawUrl = await searchSolutionFile(problemTitle);
        console.log(`Solution file found: ${rawUrl}`);

        // Step 3: Fetch the raw content of the solution file
        const solutionContent = await fetchRawContent(rawUrl);

        // Step 4: Extract and clean the solution
        const solutionClassCode = extractSolutionClass(solutionContent);
        const cleanedCode = removeComments(solutionClassCode);

        console.log("=================================");
        console.log("Extracted C++ Solution Class Code:");
        console.log("=================================");
        console.log(cleanedCode);

        // Step 5: Submit the solution to LeetCode
        await submitToLeetCode(cleanedCode, leetcodeUrl);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
})();