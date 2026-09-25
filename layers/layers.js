var wms_layers = [];


        var lyr_googleroadmap_0 = new ol.layer.Tile({
            'title': 'google roadmap',
            'opacity': 1.000000,
            
            
            source: new ol.source.XYZ({
            attributions: ' ',
                url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}'
            })
        });
var format_SIDOARJO_1 = new ol.format.GeoJSON();
var features_SIDOARJO_1 = format_SIDOARJO_1.readFeatures(json_SIDOARJO_1, 
            {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
var jsonSource_SIDOARJO_1 = new ol.source.Vector({
    attributions: ' ',
});
jsonSource_SIDOARJO_1.addFeatures(features_SIDOARJO_1);
var lyr_SIDOARJO_1 = new ol.layer.Vector({
                declutter: false,
                source:jsonSource_SIDOARJO_1, 
                style: style_SIDOARJO_1,
                popuplayertitle: 'SIDOARJO',
                interactive: true,
                title: '<img src="styles/legend/SIDOARJO_1.png" /> SIDOARJO'
            });
var format_surabaya_2 = new ol.format.GeoJSON();
var features_surabaya_2 = format_surabaya_2.readFeatures(json_surabaya_2, 
            {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
var jsonSource_surabaya_2 = new ol.source.Vector({
    attributions: ' ',
});
jsonSource_surabaya_2.addFeatures(features_surabaya_2);
var lyr_surabaya_2 = new ol.layer.Vector({
                declutter: false,
                source:jsonSource_surabaya_2, 
                style: style_surabaya_2,
                popuplayertitle: 'surabaya',
                interactive: true,
                title: '<img src="styles/legend/surabaya_2.png" /> surabaya'
            });

// Denpasar layer: create vector layer from json_Denpasar_1 if present
try {
    if (typeof json_Denpasar_1 !== 'undefined') {
        var format_Denpasar_1 = new ol.format.GeoJSON();
        var features_Denpasar_1 = format_Denpasar_1.readFeatures(json_Denpasar_1, {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
        var jsonSource_Denpasar_1 = new ol.source.Vector({ attributions: ' ', });
        jsonSource_Denpasar_1.addFeatures(features_Denpasar_1);
        // style_Denpasar_1 may not exist; omit style if undefined
        var lyr_Denpasar_1 = new ol.layer.Vector({
            declutter: false,
            source: jsonSource_Denpasar_1,
            // style: typeof style_Denpasar_1 !== 'undefined' ? style_Denpasar_1 : undefined,
            popuplayertitle: 'Denpasar',
            interactive: true,
            title: '<img src="styles/legend/Denpasar_1.png" /> Denpasar'
        });
    }
} catch(e) { console.warn('Failed to create Denpasar layer', e); }

// Ensure layers are visible if they exist
lyr_googleroadmap_0.setVisible(true);
if (typeof lyr_SIDOARJO_1 !== 'undefined') lyr_SIDOARJO_1.setVisible(true);
if (typeof lyr_surabaya_2 !== 'undefined') lyr_surabaya_2.setVisible(true);
if (typeof lyr_Denpasar_1 !== 'undefined') lyr_Denpasar_1.setVisible(true);

// Build layersList including Denpasar if available
var layersList = [lyr_googleroadmap_0];
if (typeof lyr_SIDOARJO_1 !== 'undefined') layersList.push(lyr_SIDOARJO_1);
if (typeof lyr_surabaya_2 !== 'undefined') layersList.push(lyr_surabaya_2);
if (typeof lyr_Denpasar_1 !== 'undefined') layersList.push(lyr_Denpasar_1);
lyr_SIDOARJO_1.set('fieldAliases', {'Ward': 'Ward', 'District': 'District', 'CITY': 'CITY', });
lyr_surabaya_2.set('fieldAliases', {'CITY': 'CITY', 'District': 'District', 'Ward': 'Ward', });
lyr_SIDOARJO_1.set('fieldImages', {'Ward': 'TextEdit', 'District': 'TextEdit', 'CITY': 'TextEdit', });
lyr_surabaya_2.set('fieldImages', {'CITY': 'TextEdit', 'District': 'TextEdit', 'Ward': 'TextEdit', });
lyr_SIDOARJO_1.set('fieldLabels', {'Ward': 'no label', 'District': 'no label', 'CITY': 'no label', });
lyr_surabaya_2.set('fieldLabels', {'CITY': 'no label', 'District': 'no label', 'Ward': 'no label', });
lyr_surabaya_2.on('precompose', function(evt) {
    evt.context.globalCompositeOperation = 'normal';
});