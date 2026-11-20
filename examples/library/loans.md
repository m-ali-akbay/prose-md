# Loans

A member borrows a book for 14 days. Borrowing fails if no copy is available, if the member is suspended, or if the member already has 5 active loans, or already has an overdue loan.

Returning a book that is more than 14 days late suspends the member automatically for 7 days. A loan can be renewed once, extending it by 7 days, unless it is already overdue.

The service must accept a configurable "now" through an `X-Fake-Now` request header so that tests and demos can simulate the passage of time.

Members with a suspension can still renew nothing: renewing is also refused while a member is suspended. Add a "loan history" view that lists all loans (active and returned) of a member, newest first.


Late returns accrue a fine of 0.25 per day late. A member whose unpaid fines exceed 5.00 cannot borrow. Fines can be viewed per member and paid (fully or partially).
