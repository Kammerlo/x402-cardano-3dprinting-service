// Proof of Print — one-piece FDM token, 54 mm diameter.
// Print flat, no supports; 0.2 mm layers, 3 walls, PLA.
$fn=96;
module token() {
  union() {
    cylinder(h=3.2, r=27);
    translate([0,0,3.2]) cylinder(h=1.0, r=17);
    // Raised circular accent around the outer face.
    difference() {
      translate([0,0,3.2]) cylinder(h=0.7, r=23.8);
      translate([0,0,3.1]) cylinder(h=0.9, r=22.2);
    }
    // Center constellation: one center, six inner, six outer dots.
    translate([0,0,4.2]) cylinder(h=0.8, r=2.1);
    for (a=[0:60:300]) {
      translate([7*cos(a),7*sin(a),4.2]) cylinder(h=0.8,r=1.45);
      translate([12*cos(a+30),12*sin(a+30),4.2]) cylinder(h=0.8,r=1.45);
    }
  }
}
token();
