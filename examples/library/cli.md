# Command line client

A Python 3 command line client named `libctl`, using only the standard library. It talks to the service over HTTP; the base URL comes from the `LIBRARY_URL` environment variable (default http://localhost:8080).

Commands: add a book, search books, register a member, borrow, return, and show overdue loans. Output is a plain aligned table; errors from the service are shown as a single readable line and give a non-zero exit code.
