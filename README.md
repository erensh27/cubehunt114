# CubeHunt114

CubeHunt114 is a distributed mathematical research project searching for integer solutions to the Diophantine equation:

$$x^3 + y^3 + z^3 = 114, \qquad x, y, z \in \mathbb{Z}$$

Among all positive integers up to 1000, 114 is the smallest integer whose representation as a sum of three integer cubes remains unknown.

Because 114 leaves a remainder of 6 when divided by 9, solutions are expected to exist by the heuristics of modern number theory. However, because earlier supercomputer searches showed that no solution exists with coordinates below ten quadrillion, any solution must involve integers of immense magnitude.

CubeHunt114 implements a decentralized search across 81 mathematically isolated channels, evaluating billions of combinations every minute.

For guidelines on participating and donating compute power, please consult CONTRIBUTING.md.


## 1. The Core Mathematical Concept

A brute force search across three integer variables $x, y, z$ requires cubic time complexity. Searching coordinates up to a bound $B$ would demand roughly $B^3$ operations. At $B = 10^{16}$, this would require $10^{48}$ calculations, which is impossible for modern computing.

CubeHunt114 uses the cubic field norm sieve developed by Andrew Booker and Andrew Sutherland, which transforms the three variable search into a one variable scan with sublinear complexity.

### The Algebraic Reduction

Assume a solution exists and rewrite the equation by grouping two variables:

$$x + y = s$$

Using the algebraic factorization of the sum of two cubes:

$$x^3 + y^3 = (x + y)(x^2 - xy + y^2) = s \cdot \frac{3(x - y)^2 + s^2}{4}$$

Substituting this identity back into $x^3 + y^3 + z^3 = 114$:

$$s \cdot \frac{3(x - y)^2 + s^2}{4} = 114 - z^3$$

Let $d = |s|$. This formulation reveals three vital properties:

1. Divisibility: The integer $d$ must divide $114 - z^3$.
2. Modular Cube Root: $z^3 \equiv 114 \pmod d$.
3. Integer Square Test: Defining $v = |x - y|$, we can rearrange the equation as:

$$v^2 = \frac{4(114 - z^3) - s^3}{3s}$$

If the quantity on the right is a non-negative integer and an exact perfect square, then:

$$x = \frac{s + v}{2}, \qquad y = \frac{s - v}{2}$$

This provides the exact integer values for $x$ and $y$. The entire challenge therefore reduces to finding pairs $(d, z)$ such that $d$ divides $z^3 - 114$ and the resulting quotient produces an exact square.


## 2. The Cubic Field Norm Sieve

Iterating over arbitrary integers $d$ and factoring $z^3 - 114$ is prohibitively slow because integer factorization has high computational complexity.

Instead, the algorithm generates integers $d$ directly from the algebraic number field:

$$K = \mathbb{Q}(\alpha), \qquad \alpha = \sqrt[3]{114}$$

Consider an algebraic integer in this field:

$$\gamma = a + b\alpha + c\alpha^2$$

The field norm of $\gamma$, denoted $N(\gamma)$, represents the determinant of multiplication by $\gamma$ and is given by:

$$N(\gamma) = a^3 + 114b^3 + 12996c^3 - 342abc$$

Whenever $a, b, c$ are chosen such that $N(\gamma)$ is divisible by a lattice modulus $\ell$, the integer $d = N(\gamma)/\ell$ is guaranteed to satisfy the required algebraic properties.

### Instant Modular Roots via Adjoint Coefficients

Standard algorithms compute modular cube roots using prime factorizations and Tonelli-Shanks style algorithms.

In this cubic field, the modular root is obtained algebraically from the adjoint matrix of multiplication by $\gamma$. Defining:

$$B = 114c^2 - ab$$
$$C = b^2 - ac$$

Whenever $C$ and $d$ are coprime, the exact modular cube root is given directly by:

$$r \equiv B \cdot C^{-1} \pmod d$$

This root satisfies $r^3 \equiv 114 \pmod d$ without requiring any integer factorization.


## 3. The Coordinate Space: Contexts, Shells, Bands, Rows, and Blocks

To distribute computation across independent worker processes with zero overlap, CubeHunt114 partitions the search space into 81 distinct channels called contexts.

Every task in the project is structured through a precise hierarchy:

```
Contexts (81 distinct channels)
  ↳ Rows (2D lattice points in b and c)
      ↳ Blocks (1D slices along the a coordinate)
          ↳ Tasks (the atomic unit of verification)
```

### Contexts

There are 81 contexts, identified from c00 through c80. A context is defined by four mathematical parameters:

1. Ell Modulus: $\ell \in \{1, 5, 25\}$. This congruence modulus fixes residue constraints on the algebraic integers, avoiding redundant lattice points.
2. Geometric Shape: Three shape configurations index 0, 1, and 2 determine the aspect ratio of the bounding box for $b$ and $c$:
   - Shape 0 uses radius 6,000,000 with parameter $t$ in $[8, 31]$.
   - Shape 1 uses radius 1,500,000 with parameter $t$ in $[128, 511]$.
   - Shape 2 uses radius 375,000 with parameter $t$ in $[2048, 8191]$.
3. Shell: Three shell tiers index 0, 1, and 2 partition the magnitude of the divisor $d$. With base constant $D_0 = 10^{19} / 54 \approx 1.85 \times 10^{17}$:
   - Shell 0 covers $d \in [D_0, 2D_0]$.
   - Shell 1 covers $d \in [2D_0, 4D_0]$.
   - Shell 2 covers $d \in [4D_0, 8D_0]$.
4. Band: Three band intervals index 0, 1, and 2 partition the ratio of $z/d$:
   - Band 0 evaluates $z/d \in [0, 64]$.
   - Band 1 evaluates $z/d \in [64, 256]$.
   - Band 2 evaluates $z/d \in [256, 4096]$.

Because each parameter has 3 options, $3 \times 3 \times 3 \times 3 = 81$ contexts cover the complete search landscape.

### Rows

For a chosen context, $b$ and $c$ form a two dimensional integer lattice within a square of width $2R + 1$:

$$b = (\text{row} \pmod{\text{width}}) - R$$
$$c = (\text{row} \mathbin{/} \text{width}) - R$$

A task evaluates 128 consecutive lattice rows at a time.

### Blocks

For each $(b, c)$ pair, the parameter $t$ controls the leading coefficient $a$. The admissible range of $t$ is divided into blocks of size 16.

An atomic task identifier is formatted as:

```
114-engine-v1:context:row:block
```

For example, `114-engine-v1:c47:1666560:320` represents context c47, starting at row 1666560, evaluating block 320.


## 4. The Multi-Stage Sieve Pipeline

Each task runs through an optimized screening pipeline designed to eliminate over 99.999% of invalid candidates using minimal CPU cycles:

```
[ Algebraic Generator (a, b, c) ]
               │
               ▼
[ Shell Monotonicity Check ] ──(out of range)──► Skip
               │
               ▼
[ Modulo 8 & 361 Residue Filters ] ──(incompatible)──► Skip
               │
               ▼
[ Adjoint Root Computation: r = B * C^(-1) mod d ]
               │
               ▼
[ Modulo 243 Sieve ] ──(>95% of quotient points eliminated)──► Skip
               │
               ▼
[ Parity Filter ] ──(odd parity)──► Skip
               │
               ▼
[ 15-Prime Quadratic Residue Sieve ] ──(non-residue)──► Skip
               │
               ▼
[ Exact Integer Square Root Test ] ──(not a square)──► Skip
               │
               ▼
[ Solution Verified! ] ──► Exact Triple Logged
```

### Stage 1: Shell Monotonicity Check
Analytical derivatives of $N(a)$ determine whether the norm falls within the requested shell window $[d_{\text{low}}, d_{\text{high}}]$. Monotonicity allows entire ranges of $a$ to be pruned simultaneously without computing individual norms.

### Stage 2: Signed Divisibility Filters
The divisor $d$ must not be divisible by 3. Furthermore, signed constraints modulo 8 and modulo 361 eliminate residue classes where cubic reciprocity prohibits integer solutions.

### Stage 3: Modulo 243 Sieve
Modulo $3^5 = 243$, the sum of three cubes has an extremely restricted set of residues. By projecting candidates into precomputed 243-element bit tables, more than 95% of quotient candidates $q$ are eliminated through a single bitwise lookup.

### Stage 4: Parity Filter
The parity relation enforces that $114 - s - z$ must be even, ensuring integer division by 2 when computing $x$ and $y$.

### Stage 5: Small Prime Quadratic Residue Sieve
The quantity $4(114 - z^3) - s^3$ must be a quadratic residue modulo small primes. Candidates are checked against precomputed bitmasks for 15 primes:

$$\{5, 7, 11, 13, 17, 19, 23, 31, 37, 41, 43, 47, 53, 59, 61\}$$

Any candidate that is a quadratic non-residue modulo any of these primes is discarded.

### Stage 6: Exact Square Root Verification
Candidates passing all sieve stages undergo an exact integer square root evaluation using `isqrt`. If the candidate produces a perfect square, $x$ and $y$ are calculated and tested against the original equation:

$$x^3 + y^3 + z^3 = 114$$

If confirmed, the exact triple is saved immediately and flagged as a solution.


## 5. Coordination and Sharded Ledger

CubeHunt114 ensures zero duplicated effort across all participants through a deterministic coordination layer:

1. Coordination State (`data/blocks.json`):
   Miners retrieve this file to determine the latest progress frontiers and high water marks across all 81 contexts. It also reports total blocks and combinations verified for every context.
2. Sharded Completed Ledger (`data/completed/cNN/`):
   Completed task identifiers are stored in context directories divided into 256 hash buckets. Each bucket contains deterministic JSON files limited to bounded sizes, ensuring Git repositories remain responsive and manageable over long multi-terabyte search campaigns.
3. Cryptographic Verification:
   Every batch computes a deterministic SHA-256 digest over the exact set of evaluated tasks and counters, guaranteeing mathematical integrity and reproducibility across different operating systems.
