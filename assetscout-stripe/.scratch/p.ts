class A { constructor(private readonly x: number = 1) {} get v(): number { return this.x; } }
console.log(new A(5).v);
